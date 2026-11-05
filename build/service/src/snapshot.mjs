// "Fast start": downloads the recent copy of the Starknet database that the
// Juno team publishes, and unpacks it while it downloads (no second copy on
// disk). A dropped connection continues where it stopped (HTTP Range with
// If-Range on the ETag, so a newer file on the server is never mixed in).
// If the box restarts in the middle, the half-unpacked copy is removed and the
// download starts again.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

export const PRUNED_SNAPSHOT_URL = "https://juno-snapshots.nethermind.io/files/mainnet-pruned/latest";

function get(url, headers, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? httpsRequest : httpRequest)(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), headers, redirects - 1));
        return;
      }
      resolve(res);
    });
    req.setTimeout(60000, () => req.destroy(new Error("no data for 60 seconds")));
    req.on("error", reject);
    req.end();
  });
}

export class SnapshotDownload {
  constructor({ url = PRUNED_SNAPSHOT_URL, target, log = () => {}, unpackCmd = ["sh", ["-c", "zstd -d -q -c | tar -x -f - --no-same-owner -C \"$TARGET\""]] }) {
    this.url = url;
    this.target = target;
    this.partial = `${target}.partial`;
    this.log = log;
    this.unpackCmd = unpackCmd;
    this.state = "idle"; // idle | running | done | failed | cancelled
    this.bytes = 0;
    this.total = null;
    this.startedAt = null;
    this.error = null;
    this.cancelled = false;
    this.req = null;
    this.unpack = null;
  }

  status() {
    return {
      state: this.state,
      bytes: this.bytes,
      total: this.total,
      startedAt: this.startedAt,
      error: this.error,
    };
  }

  cancel() {
    this.cancelled = true;
    if (this.req) this.req.destroy(new Error("cancelled"));
    if (this.unpack) this.unpack.kill("SIGTERM");
  }

  /** Size of the file on the server and its ETag, without downloading it. */
  async head() {
    const res = await get(this.url, { range: "bytes=0-0" });
    res.resume();
    if (res.statusCode !== 206 && res.statusCode !== 200) throw new Error(`the download server answered ${res.statusCode}`);
    const range = /\/(\d+)$/.exec(res.headers["content-range"] || "");
    const total = range ? Number(range[1]) : Number(res.headers["content-length"]);
    return { total: Number.isFinite(total) ? total : null, etag: res.headers.etag || null };
  }

  /** Resolves when the copy is unpacked into `target`; rejects on failure or cancel. */
  async run() {
    this.state = "running";
    this.startedAt = Date.now();
    this.bytes = 0;
    this.error = null;
    rmSync(this.partial, { recursive: true, force: true });
    mkdirSync(this.partial, { recursive: true });
    try {
      const { total, etag } = await this.head();
      this.total = total;
      this.log(`fast start: downloading ${total ? `${(total / 1e9).toFixed(1)} GB` : "the database copy"} from ${this.url}`);
      await this.stream(etag);
      if (this.cancelled) throw new Error("cancelled");
      // the archive holds the database files at its top level
      if (readdirSync(this.partial).length === 0) throw new Error("the downloaded copy was empty");
      rmSync(this.target, { recursive: true, force: true });
      renameSync(this.partial, this.target);
      this.state = "done";
      this.log("fast start: database copy unpacked");
    } catch (err) {
      this.state = this.cancelled ? "cancelled" : "failed";
      this.error = this.cancelled ? null : err.message;
      rmSync(this.partial, { recursive: true, force: true });
      this.log(`fast start: ${this.cancelled ? "cancelled" : `failed: ${err.message}`}`);
      throw err;
    } finally {
      this.req = null;
      this.unpack = null;
    }
  }

  stream(etag) {
    return new Promise((resolve, reject) => {
      const [cmd, args] = this.unpackCmd;
      const unpack = spawn(cmd, args, { env: { ...process.env, TARGET: this.partial }, stdio: ["pipe", "ignore", "pipe"] });
      this.unpack = unpack;
      let unpackErr = "";
      unpack.stderr.on("data", (b) => (unpackErr = (unpackErr + b.toString()).slice(-2000)));
      let finished = false;
      unpack.on("exit", (code) => {
        if (finished) return;
        finished = true;
        if (this.req) this.req.destroy();
        if (code === 0 && (this.total === null || this.bytes >= this.total)) resolve();
        else reject(new Error(`unpacking stopped${unpackErr ? `: ${unpackErr.trim().split("\n").pop()}` : ""}`));
      });
      unpack.stdin.on("error", () => {}); // reported through "exit"

      let failures = 0;
      const next = async () => {
        if (finished) return;
        if (this.cancelled) return unpack.kill("SIGTERM");
        if (this.total !== null && this.bytes >= this.total) return unpack.stdin.end();
        const headers = this.bytes > 0 ? { range: `bytes=${this.bytes}-`, ...(etag ? { "if-range": etag } : {}) } : {};
        let res;
        try {
          res = await get(this.url, headers);
        } catch (err) {
          return retry(err);
        }
        if (this.bytes > 0 && res.statusCode !== 206) {
          res.resume();
          // the server no longer has the same file (a newer copy was published): start over
          unpack.kill("SIGTERM");
          return;
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return retry(new Error(`the download server answered ${res.statusCode}`));
        }
        this.req = res;
        res.on("data", (chunk) => {
          this.bytes += chunk.length;
          failures = 0;
          if (!unpack.stdin.write(chunk)) {
            res.pause();
            unpack.stdin.once("drain", () => res.resume());
          }
        });
        res.on("end", () => {
          this.req = null;
          if (this.total === null || this.bytes >= this.total) unpack.stdin.end();
          else retry(new Error("the connection closed early"));
        });
        res.on("error", (err) => {
          this.req = null;
          retry(err);
        });
      };
      const retry = (err) => {
        if (finished) return;
        if (this.cancelled) return unpack.kill("SIGTERM");
        failures += 1;
        if (failures > 30) {
          unpack.kill("SIGTERM");
          return;
        }
        const pause = Math.min(5000 * failures, 60000);
        this.log(`fast start: ${err.message}; trying again in ${pause / 1000} s`);
        setTimeout(next, pause);
      };
      next();
    });
  }
}

/** True when the Juno database folder is missing or empty. */
export function databaseIsEmpty(dir) {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}
