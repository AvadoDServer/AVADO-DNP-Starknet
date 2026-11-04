import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotDownload } from "../src/snapshot.mjs";

// A test server that drops the connection half way once, then serves Range requests.
function server(payload) {
  let dropped = false;
  const srv = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : payload.length - 1;
    const headers = { "accept-ranges": "bytes", etag: '"v1"' };
    if (m) {
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${payload.length}`, "content-length": end - start + 1 });
    } else {
      res.writeHead(200, { ...headers, "content-length": payload.length });
    }
    const body = payload.subarray(start, end + 1);
    if (!dropped && start === 0 && end === payload.length - 1) {
      dropped = true;
      res.write(body.subarray(0, Math.floor(body.length / 2)));
      setTimeout(() => res.destroy(), 50);
      return;
    }
    res.end(body);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

test("download resumes after a dropped connection and unpacks into the target", async () => {
  const payload = Buffer.from("x".repeat(200000) + "END");
  const srv = await server(payload);
  const dir = mkdtempSync(join(tmpdir(), "snap-"));
  const target = join(dir, "juno");
  // "unpack" = copy stdin into a file in the target folder
  const dl = new SnapshotDownload({
    url: `http://127.0.0.1:${srv.address().port}/latest`,
    target,
    unpackCmd: ["sh", ["-c", 'cat > "$TARGET/db"']],
  });
  // speed up the retry pause for the test
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 20), ...a);
  try {
    await dl.run();
  } finally {
    global.setTimeout = realSetTimeout;
    srv.close();
  }
  assert.equal(dl.state, "done");
  assert.equal(dl.bytes, payload.length);
  assert.equal(readFileSync(join(target, "db")).toString(), payload.toString());
  assert.equal(existsSync(`${target}.partial`), false);
});

test("a failed unpack removes the half-made copy", async () => {
  const payload = Buffer.from("y".repeat(1000));
  const srv = await server(payload);
  const dir = mkdtempSync(join(tmpdir(), "snap-"));
  const target = join(dir, "juno");
  const dl = new SnapshotDownload({ url: `http://127.0.0.1:${srv.address().port}/latest`, target, unpackCmd: ["sh", ["-c", "exit 3"]] });
  await assert.rejects(dl.run());
  srv.close();
  assert.equal(dl.state, "failed");
  assert.equal(existsSync(`${target}.partial`), false);
  assert.equal(existsSync(target), false);
});
