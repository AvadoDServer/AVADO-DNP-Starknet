// Runs one long-lived program (a node, a validator) inside the package
// container: starts it, keeps its last log lines for the page, restarts it with
// a growing pause when it stops on its own, and stops it cleanly on request.
import { spawn } from "node:child_process";

const KEEP_LINES = 400;

/** Hide anything that looks like a private key or a recovery phrase before it reaches the page. */
export function redact(line, secrets = []) {
  let out = String(line);
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[hidden]");
  // 12 or 24 lower-case words in a row look like a recovery phrase
  out = out.replace(/\b(?:[a-z]{3,8} ){11,23}[a-z]{3,8}\b/g, "[hidden]");
  // a value right after "private key", "secret", "mnemonic" or "password"
  out = out.replace(/((?:priv(?:ate)?[_ -]?key|secret|mnemonic|password)\S*\s*[:=]\s*"?)([^\s",}]+)/gi, "$1[hidden]");
  return out;
}

export class Supervised {
  /**
   * name: short label for logs; build(): {cmd, args, env} or null when it must not run now
   * onLine(line): optional hook for every output line (already redacted)
   */
  constructor({ name, build, onLine, secrets = () => [], stopSignal = "SIGTERM", stopTimeoutMs = 60000 }) {
    this.name = name;
    this.build = build;
    this.onLine = onLine;
    this.secrets = secrets;
    this.stopSignal = stopSignal;
    this.stopTimeoutMs = stopTimeoutMs;
    this.child = null;
    this.wanted = false;
    this.lines = [];
    this.restarts = 0;
    this.startedAt = null;
    this.lastExit = null;
    this.timer = null;
  }

  get running() {
    return this.child !== null;
  }

  push(line) {
    const clean = redact(line.replace(/\x1b\[[0-9;]*m/g, ""), this.secrets());
    this.lines.push(clean);
    if (this.lines.length > KEEP_LINES) this.lines.splice(0, this.lines.length - KEEP_LINES);
    process.stdout.write(`[${this.name}] ${clean}\n`);
    if (this.onLine) this.onLine(clean);
  }

  start() {
    this.wanted = true;
    if (this.child || this.timer) return;
    const spec = this.build();
    if (!spec) {
      this.wanted = false;
      return;
    }
    const child = spawn(spec.cmd, spec.args, { env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.startedAt = Date.now();
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream.on("data", (buf) => {
        const parts = (rest + buf.toString("utf8")).split("\n");
        rest = parts.pop();
        for (const p of parts) if (p.trim()) this.push(p);
        if (rest.length > 8192) {
          this.push(rest);
          rest = "";
        }
      });
    }
    child.on("error", (err) => this.push(`could not start: ${err.message}`));
    child.on("exit", (code, signal) => {
      this.child = null;
      this.lastExit = { code, signal, at: Date.now() };
      if (!this.wanted) return;
      const ranFor = Date.now() - (this.startedAt || 0);
      if (ranFor > 10 * 60 * 1000) this.restarts = 0;
      this.restarts += 1;
      const pause = Math.min(5000 * 2 ** Math.min(this.restarts - 1, 5), 160000);
      this.push(`stopped (code ${code ?? "-"}${signal ? `, ${signal}` : ""}); starting again in ${Math.round(pause / 1000)} s`);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.wanted) this.start();
      }, pause);
    });
  }

  /** Stops the program and waits until it has exited. */
  stop() {
    this.wanted = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), this.stopTimeoutMs);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill(this.stopSignal);
    });
  }

  async restart() {
    await this.stop();
    this.restarts = 0;
    this.start();
  }

  status() {
    return {
      running: this.running,
      startedAt: this.running ? this.startedAt : null,
      restarts: this.restarts,
      lastExit: this.lastExit,
    };
  }

  tail(n = 200) {
    return this.lines.slice(-n);
  }
}
