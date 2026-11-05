// lib/https.mjs: the page also answers on https with the box's *.my.ava.do
// certificate, and stays http only (never crashes) without a usable one.
// The pairs below are self-signed test pairs made for these tests (valid until
// 2126); they protect nothing. Same file in AVADO-DNP-Starknet and AVADO-DNP-Aztec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { request } from "node:https";
import { createServer } from "node:net";
import { checkPair, CertWatcher, serveHttps } from "../src/lib/https.mjs";
import { createPageHandler, createPageServer } from "../src/lib/http.mjs";

const GOOD_CRT = `-----BEGIN CERTIFICATE-----
MIIBejCCASCgAwIBAgIUAi8JlEFN6pZYIUF9hQ3XjCv8sDkwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLKi5teS5hdmEuZG8wIBcNMjYxMTA1MTI1MzQ5WhgPMjEyNjEw
MTIxMjUzNDlaMBYxFDASBgNVBAMMCyoubXkuYXZhLmRvMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEYXPTaSMTySWECRGi0YqT4xqaASeR7ZTnEkP6CA8ypPAew5I6
Ta0oegvRGi3UD0a96Zth6fh1hw/akd43lWuhg6NKMEgwHQYDVR0OBBYEFHNkouNY
fiXN75qJ3pQgVsQ2eDiLMA8GA1UdEwEB/wQFMAMBAf8wFgYDVR0RBA8wDYILKi5t
eS5hdmEuZG8wCgYIKoZIzj0EAwIDSAAwRQIgJmesUpGWeI8GPYxz6AaN6hwAqtL/
C7mOWQWkrx3lfacCIQDMfpqRBttWI94HVRdCX2AHUusaZB5QbXFPV1O13KumOA==
-----END CERTIFICATE-----
`;
const GOOD_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgrvH0Mmvgd9HsvSix
Cw5EGK+8GIPsZolheWD4O9gAVn6hRANCAARhc9NpIxPJJYQJEaLRipPjGpoBJ5Ht
lOcSQ/oIDzKk8B7DkjpNrSh6C9EaLdQPRr3pm2Hp+HWHD9qR3jeVa6GD
-----END PRIVATE KEY-----
`;
const OTHER_CRT = `-----BEGIN CERTIFICATE-----
MIIBfzCCASagAwIBAgIUXmJBqNfJn9y9HtrSBJFXE7tQ3h4wCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNKi5leGFtcGxlLmNvbTAgFw0yNjExMDUxMjUzNDlaGA8yMTI2
MTAxMjEyNTM0OVowGDEWMBQGA1UEAwwNKi5leGFtcGxlLmNvbTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABFh11s1NvVaoNK+lQRP111LXxsHvrHVxV1xNUVwBuGWU
tj1pVUTYa30RSrzZiEKl6Yk8o7GQyrJHzT1XzO4ehB2jTDBKMB0GA1UdDgQWBBRZ
Pkxotav9b2xh7LUn7XnULbYA0zAPBgNVHRMBAf8EBTADAQH/MBgGA1UdEQQRMA+C
DSouZXhhbXBsZS5jb20wCgYIKoZIzj0EAwIDRwAwRAIgYlO6QQ43mEnVYEAWMr/p
Z/ucYiA7YAh/CCCMMCzyQAoCIFzekMD8DVmcjtmR8Zb+iN7baUm4QizkgXc8w9hu
ufDR
-----END CERTIFICATE-----
`;
const OTHER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQglKCizmOFbrR3akAU
EL3VbklpifuXrL1bQwtLVE9kV4ehRANCAARYddbNTb1WqDSvpUET9ddS18bB76x1
cVdcTVFcAbhllLY9aVVE2Gt9EUq82YhCpemJPKOxkMqyR809V8zuHoQd
-----END PRIVATE KEY-----
`;

const DAPPMANAGER = "http://dappmanager.my.ava.do";

/** Stands in for http://dappmanager.my.ava.do: { url: text }; a missing url is "connection refused". */
function fakeFetch(files = {}) {
  const fn = async (url) => {
    fn.calls++;
    if (!(url in fn.files)) throw new Error("connection refused");
    return { ok: true, status: 200, text: async () => fn.files[url] };
  };
  fn.files = files;
  fn.calls = 0;
  fn.serve = (cert, key, base = DAPPMANAGER) => {
    fn.files[`${base}/my.ava.do.crt`] = cert;
    fn.files[`${base}/my.ava.do.key`] = key;
  };
  return fn;
}

const quiet = () => {};
const hello = (_req, res) => res.end("same page");

function get(port, path = "/", host = "starknet.my.ava.do") {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, servername: host, ca: GOOD_CRT, headers: { host } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

test("checkPair: good pair, chain file, wrong name, wrong key, dates, garbage", () => {
  assert.match(checkPair(GOOD_CRT, GOOD_KEY), /2126/);
  assert.match(checkPair(GOOD_CRT + OTHER_CRT, GOOD_KEY), /2126/);
  assert.throws(() => checkPair(OTHER_CRT, OTHER_KEY), /not for \*\.my\.ava\.do/);
  assert.throws(() => checkPair(GOOD_CRT, OTHER_KEY), /key does not belong/);
  const end = Date.parse("Oct 12 12:53:49 2126 GMT");
  assert.throws(() => checkPair(GOOD_CRT, GOOD_KEY, end - 30 * 60 * 1000), /ends/);
  checkPair(GOOD_CRT, GOOD_KEY, end - 2 * 60 * 60 * 1000);
  assert.throws(() => checkPair(GOOD_CRT, GOOD_KEY, 0), /valid only from/);
  assert.throws(() => checkPair("", ""), /no certificate/);
  assert.throws(() => checkPair("<html>502</html>", GOOD_KEY));
  assert.throws(() => checkPair(GOOD_CRT, "nope"));
});

test("watcher: waits while the DAPPMANAGER is down, then uses it once", async () => {
  const f = fakeFetch();
  const changes = [];
  const lines = [];
  const w = new CertWatcher({ onChange: (x) => changes.push(x.validTo), fetchImpl: f, log: (l) => lines.push(l) });
  assert.equal(await w.refresh(), false);
  assert.equal(await w.refresh(), false);
  assert.equal(lines.length, 1); // said once
  f.serve(GOOD_CRT, GOOD_KEY);
  assert.equal(await w.refresh(), true);
  assert.equal(await w.refresh(), true);
  assert.equal(changes.length, 1);
});

test("watcher: second source, bad new copy keeps the old one, failing onChange is retried", async () => {
  const iso = fakeFetch();
  iso.serve(GOOD_CRT, GOOD_KEY, "http://iso.ava.do");
  assert.equal(await new CertWatcher({ onChange: () => true, fetchImpl: iso }).refresh(), true);

  const f = fakeFetch();
  f.serve(GOOD_CRT, GOOD_KEY);
  const w = new CertWatcher({ onChange: () => true, fetchImpl: f, log: quiet });
  assert.equal(await w.refresh(), true);
  f.serve(GOOD_CRT, OTHER_KEY);
  assert.equal(await w.refresh(), false);
  assert.equal(w.key, GOOD_KEY);

  let calls = 0;
  const r = new CertWatcher({
    onChange: () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return calls > 2;
    },
    fetchImpl: iso,
    log: quiet,
  });
  assert.equal(await r.refresh(), false);
  assert.equal(await r.refresh(), false);
  assert.equal(await r.refresh(), true);
});

test("the page handler answers the same on http and https", async () => {
  const f = fakeFetch();
  f.serve(GOOD_CRT, GOOD_KEY);
  const page = { publicDir: "/nonexistent", routes: { "GET /api/status": async () => ({ ok: "yes" }) }, allowedNames: ["starknet.my.ava.do"] };
  const port = await freePort();
  const w = serveHttps(createPageHandler(page), { port, host: "127.0.0.1", fetchImpl: f, log: quiet });
  await until(() => w.server);
  try {
    const res = await get(port, "/api/status");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: "yes" });
    const plain = createPageServer(page);
    await new Promise((r) => plain.listen(0, "127.0.0.1", r));
    const viaHttp = await new Promise((resolve, reject) => {
      httpGet({ host: "127.0.0.1", port: plain.address().port, path: "/api/status", headers: { host: "starknet.my.ava.do" } }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve(body));
      }).on("error", reject);
    });
    plain.close();
    assert.equal(viaHttp, res.body);
    // a renewed copy is swapped in without a restart
    f.serve(`${GOOD_CRT}\n`, GOOD_KEY);
    assert.equal(await w.refresh(), true);
    assert.equal((await get(port, "/api/status")).status, 200);
  } finally {
    w.stop();
  }
});

test("no certificate: no listener; port in use: http only, no crash", async () => {
  const port = await freePort();
  const w = serveHttps(hello, { port, host: "127.0.0.1", fetchImpl: fakeFetch(), log: quiet });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(w.server, null);
  await assert.rejects(get(port), /ECONNREFUSED/);
  w.stop();

  const busy = createServer();
  await new Promise((r) => busy.listen(0, "127.0.0.1", r));
  const f = fakeFetch();
  f.serve(GOOD_CRT, GOOD_KEY);
  const lines = [];
  const b = new CertWatcher({ onChange: () => true, fetchImpl: f });
  assert.equal(await b.refresh(), true);
  const w2 = serveHttps(hello, { port: busy.address().port, host: "127.0.0.1", fetchImpl: f, log: (l) => lines.push(l) });
  await until(() => lines.some((l) => l.includes("cannot open port")));
  assert.equal(w2.server, null);
  w2.stop();
  busy.close();
});
