// Entry point of the Starknet Validator package: the page on port 80 and the
// programs it looks after (Juno, the attestation tool).
import { readFileSync } from "node:fs";
import { createPageServer, HttpError } from "./lib/http.mjs";
import { StarknetBox } from "./starknet.mjs";

const DATA_DIR = process.env.STATE_DIR || "/data";
const PUBLIC_DIR = process.env.PUBLIC_DIR || new URL("../public", import.meta.url).pathname;
const PORT = Number(process.env.HTTP_PORT || 80);

let version = process.env.PACKAGE_VERSION || "";
try {
  version = version || readFileSync(new URL("../package-version", import.meta.url), "utf8").trim();
} catch {
  // not in the image
}

const log = (msg) => process.stdout.write(`[page] ${msg}\n`);
const box = new StarknetBox({
  dataDir: DATA_DIR,
  junoBin: process.env.JUNO_BIN || "juno",
  validatorBin: process.env.VALIDATOR_BIN || "validator",
  env: { ...process.env, PACKAGE_VERSION: version },
  log,
});

/** Turns a thrown error with a status into an HttpError the page shows as is. */
const wrap = (fn) => async (body) => {
  try {
    return await fn(body);
  } catch (err) {
    if (err.status) throw new HttpError(err.status, err.message);
    throw err;
  }
};

const routes = {
  "GET /api/status": async () => box.status(),
  "GET /api/logs": async (_b, _r, url) => ({ lines: box.logs(url.searchParams.get("which")) }),
  "POST /api/validator": wrap((b) =>
    box.setValidator({ operationalAddress: String(b.operationalAddress || "").trim(), privateKey: String(b.privateKey || "").trim(), braavos: b.braavos === true }),
  ),
  "POST /api/validator/remove": wrap(async (b) => {
    if (b.confirm !== "REMOVE") throw new HttpError(400, "Type REMOVE to confirm");
    return box.removeValidator();
  }),
  "POST /api/ethereum": wrap((b) => box.setL1({ l1: String(b.l1 || ""), l1Custom: String(b.l1Custom || "").trim() })),
  "POST /api/fast-start/skip": wrap(() => box.skipFastStart()),
  "POST /api/fast-start/use": wrap(() => box.useFastStart()),
  "POST /api/node/restart": wrap(() => box.restartNode()),
  "POST /api/node/start-over": wrap(async (b) => {
    if (b.confirm !== "START OVER") throw new HttpError(400, "Type START OVER to confirm");
    return box.startOver();
  }),
};

const server = createPageServer({
  publicDir: PUBLIC_DIR,
  routes,
  allowedNames: ["starknet.my.ava.do", "starknet.avado.dnp.dappnode.eth", "my.starknet.avado.dnp.dappnode.eth", "dappnodepackage-starknet.avado.dnp.dappnode.eth"],
  log,
});
server.listen(PORT, "0.0.0.0", () => log(`page on port ${PORT}`));
box.begin();

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping the validator and Juno`);
    server.close();
    await box.shutdown();
    process.exit(0);
  });
}
