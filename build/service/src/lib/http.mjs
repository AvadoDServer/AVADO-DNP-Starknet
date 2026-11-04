// Small HTTP layer for the package page: static files, JSON API, and the same
// page guards as the other AVADO package pages (Care, Rocket Pool, AI Connect):
// a Host allow-list against DNS rebinding and a same-origin check on every
// request that changes something.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { isIPv4, isIPv6 } from "node:net";
import { join, normalize, extname } from "node:path";

export const CSRF_HEADER = "x-avado-request";
const MAX_BODY = 64 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/** Host names the page answers to: IP literals, localhost, and the package's own names on :80. */
export function isAllowedHost(hostHeader, allowedNames) {
  if (!hostHeader) return false;
  const host = String(hostHeader).trim().toLowerCase();
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(host);
  if (v6) return isIPv6(v6[1]);
  const m = /^([a-z0-9.-]+?)\.?(?::(\d{1,5}))?$/.exec(host);
  if (!m) return false;
  const name = m[1];
  const port = m[2];
  if (isIPv4(name) || name === "localhost") return true;
  if (!allowedNames.includes(name)) return false;
  return port === undefined || port === "80";
}

function sameHost(value, host) {
  try {
    const url = new URL(value);
    return url.host.toLowerCase() === new URL(`${url.protocol}//${host}`).host.toLowerCase();
  } catch {
    return false;
  }
}

/** null when a state-changing request may go ahead, otherwise the reason it is refused. */
export function checkCsrf(req) {
  if (req.method === "GET" || req.method === "HEAD") return null;
  if (req.headers[CSRF_HEADER] !== "1") return "Missing X-Avado-Request header";
  const host = req.headers.host;
  if (!host) return "Missing Host header";
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!sameHost(origin, host)) return "Cross-origin request refused";
  } else if (req.headers.referer !== undefined && !sameHost(req.headers.referer, host)) {
    return "Cross-origin request refused";
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return "Cross-site request refused";
  return null;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new HttpError(400, "The request was not valid JSON");
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    ...headers,
  });
  res.end(body);
}

export function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8" });
}

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * routes: { "GET /api/status": async (body, req) => value, "POST /api/x": ... }
 * A handler returns a JSON value, or throws HttpError for a plain-language error.
 * Files are served only from publicDir and only with a known extension.
 */
export function createPageServer({ publicDir, routes, allowedNames, log = () => {} }) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        if (!isAllowedHost(req.headers.host, allowedNames)) return sendJson(res, 403, { error: "Unknown host name" });
        const refused = checkCsrf(req);
        if (refused) return sendJson(res, 403, { error: refused });
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) return sendJson(res, 404, { error: "Not found" });
        const body = req.method === "POST" ? await readJson(req) : {};
        const result = await handler(body, req, url);
        return sendJson(res, 200, result ?? { ok: true });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const type = TYPES[extname(rel)];
      const path = normalize(join(publicDir, rel));
      if (!type || !path.startsWith(normalize(publicDir + "/")) || rel.includes("..")) return send(res, 404, "Not found");
      const data = await readFile(path).catch(() => null);
      if (!data) return send(res, 404, "Not found");
      return send(res, 200, req.method === "HEAD" ? "" : data, {
        "content-type": type,
        ...(type.startsWith("text/html") ? { "content-security-policy": CSP } : {}),
      });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      log(`page error: ${err && err.stack ? err.stack : err}`);
      return sendJson(res, 500, { error: "Something went wrong on the box. Please try again." });
    }
  });
}
