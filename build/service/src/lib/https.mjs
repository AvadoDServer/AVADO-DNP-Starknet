// HTTPS for the package page, with the box's *.my.ava.do certificate.
//
// Chrome's "Always use secure connections" (on by default) tries
// https://<app>.my.ava.do first when an owner types the http address. A page
// that does not answer on port 443 then shows "This site doesn't support a
// secure connection". So the page also answers on 443, with the certificate
// the Admin (https://admin.my.ava.do), Vaultwarden and AI Connect use: the
// box's DAPPMANAGER serves its current copy at http://dappmanager.my.ava.do
// (iso.ava.do is the second source).
//
// - Used only when it is for *.my.ava.do, valid for at least another hour and
//   matches its key. Until there is one, the page is http only and it is
//   checked again every 5 minutes; after that once a day. Nothing here ever
//   stops the page; http works exactly as before.
// - Same rules as avadotls.py in the Python packages and certs.ts in AI Connect.
//
// The same file is in AVADO-DNP-Starknet and AVADO-DNP-Aztec; keep the copies identical.
import { createServer } from "node:https";
import { X509Certificate, createPrivateKey } from "node:crypto";

export const SOURCES = ["http://dappmanager.my.ava.do", "http://iso.ava.do"];
export const RETRY_MS = 5 * 60 * 1000;
export const REFRESH_MS = 24 * 60 * 60 * 1000;
const MIN_LEFT_MS = 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;

/** "valid until" text for a usable pair; throws with the reason otherwise. */
export function checkPair(cert, key, now = Date.now()) {
  const first = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(cert);
  if (!first) throw new Error("no certificate in the file");
  const leaf = new X509Certificate(first[0]);
  const names = (leaf.subjectAltName || "").split(/,\s*/);
  if (!names.includes("DNS:*.my.ava.do")) throw new Error(`the certificate is not for *.my.ava.do (${leaf.subjectAltName || "no names"})`);
  if (Date.parse(leaf.validFrom) > now) throw new Error(`the certificate is valid only from ${leaf.validFrom}`);
  if (Date.parse(leaf.validTo) - now < MIN_LEFT_MS) throw new Error(`the certificate ends ${leaf.validTo}`);
  if (!leaf.checkPrivateKey(createPrivateKey(key))) throw new Error("the key does not belong to the certificate");
  return leaf.validTo;
}

async function download(fetchImpl, url) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error("too large");
  return body;
}

/**
 * Keeps the box's *.my.ava.do certificate. onChange(watcher) runs when a new
 * one is in place; it may return false (for example: the port is taken) to be
 * called again next round.
 */
export class CertWatcher {
  constructor({ onChange, sources = SOURCES, fetchImpl = globalThis.fetch, log = () => {} }) {
    Object.assign(this, { onChange, sources, fetchImpl, log });
    this.cert = this.key = this.validTo = null;
    this.server = null;
    this.timer = null;
    this.said = null;
  }

  /** true when a usable certificate is in place (new or the same). */
  async refresh() {
    const problems = [];
    for (const base of this.sources) {
      let cert, key, validTo;
      try {
        [cert, key] = await Promise.all([download(this.fetchImpl, `${base}/my.ava.do.crt`), download(this.fetchImpl, `${base}/my.ava.do.key`)]);
        validTo = checkPair(cert, key);
      } catch (err) {
        problems.push(`${base}: ${err && err.message ? err.message : err}`);
        continue;
      }
      this.said = null;
      if (cert === this.cert && key === this.key) return true;
      Object.assign(this, { cert, key, validTo });
      let applied;
      try {
        applied = (await this.onChange(this)) !== false;
      } catch (err) {
        this.log(`HTTPS: could not use the new certificate: ${err && err.message ? err.message : err}`);
        applied = false;
      }
      if (!applied) this.cert = this.key = null; // try again next round
      return applied;
    }
    const text = problems.join("; ");
    if (text !== this.said) {
      this.log(`HTTPS: no usable *.my.ava.do certificate yet, http only for now (${text})`);
      this.said = text;
    }
    return false;
  }

  /** Every 5 minutes until there is a certificate, then daily. */
  start() {
    const loop = async () => {
      let ok = false;
      try {
        ok = await this.refresh();
      } catch (err) {
        this.log(`HTTPS: certificate check failed: ${err}`);
      }
      this.timer = setTimeout(loop, ok ? REFRESH_MS : RETRY_MS);
      this.timer.unref?.();
    };
    void loop();
    return this;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.server?.close();
  }
}

/** Serves the page's request handler on port 443 once the certificate is there. Returns the CertWatcher. */
export function serveHttps(handler, { port = 443, host = "0.0.0.0", log = () => {}, sources, fetchImpl } = {}) {
  const onChange = (w) => {
    if (w.server) {
      w.server.setSecureContext({ cert: w.cert, key: w.key });
      log(`HTTPS: certificate renewed, valid until ${w.validTo}`);
      return true;
    }
    const server = createServer({ cert: w.cert, key: w.key, minVersion: "TLSv1.2" }, handler);
    server.headersTimeout = 30_000;
    server.requestTimeout = 120_000;
    server.on("tlsClientError", () => {}); // plain http on 443, a scanner, a closed tab
    return new Promise((resolve) => {
      const refused = (err) => {
        log(`HTTPS: cannot open port ${port} (${err.code || err.message}); the page works over http`);
        resolve(false);
      };
      server.once("error", refused);
      server.listen(port, host, () => {
        server.off("error", refused);
        server.on("error", (err) => log(`HTTPS: ${err.message}`));
        w.server = server;
        log(`secure page on port ${server.address().port} (certificate valid until ${w.validTo})`);
        resolve(true);
      });
    });
  };
  return new CertWatcher({ onChange, sources, fetchImpl, log }).start();
}
