import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StarknetBox, explainValidatorLine, isFelt, splitOptions } from "../src/starknet.mjs";
import { parsePrometheus } from "../src/lib/metrics.mjs";

test("isFelt accepts Starknet addresses and keys, refuses junk", () => {
  assert.equal(isFelt("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"), true);
  assert.equal(isFelt("0x123"), true);
  assert.equal(isFelt("0x0"), false);
  assert.equal(isFelt("123"), false);
  assert.equal(isFelt("0x" + "1".repeat(65)), false);
  assert.equal(isFelt("word word"), false);
});

test("extra options are split on spaces only", () => {
  assert.deepEqual(splitOptions(" --log-level debug  --x=1 "), ["--log-level", "debug", "--x=1"]);
  assert.deepEqual(splitOptions("$(rm -rf /)"), ["$(rm", "-rf", "/)"]);
  assert.deepEqual(splitOptions(undefined), []);
});

test("validator lines become plain problems", () => {
  assert.equal(explainValidatorLine('error: "Staker does not exist"'), "notStaked");
  assert.equal(explainValidatorLine("Unable to get STRK balance of account 0x1: Error when calling entrypoint `balance_of`: 20 Contract not found"), "accountMissing");
  assert.equal(explainValidatorLine("signer balance is below threshold"), "lowBalance");
  assert.equal(explainValidatorLine("subscribed to new block header"), null);
  // seen on v0.3.1 with Juno v0.17.0 at every start; the validator works, so it is not a problem
  assert.equal(
    explainValidatorLine('14:05:13.216 04/11/2026 +00:00\tWARN\tvalidator/provider_interaction.go:38\tnode implements a different JSON-RPC specification than Starknet.Go targets'),
    null,
  );
});

test("prometheus text is parsed", () => {
  const m = parsePrometheus(`# HELP x\nvalidator_attestation_current_epoch_id{network="mainnet"} 14138\nvalidator_attestation_attestation_confirmed_count{network="mainnet"} 3\nbad line\n`);
  assert.equal(m.validator_attestation_current_epoch_id, 14138);
  assert.equal(m.validator_attestation_attestation_confirmed_count, 3);
});

test("the private key is stored with mode 600, never in status, and removed on request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stark-"));
  const box = new StarknetBox({ dataDir: dir, junoBin: "/bin/false", validatorBin: "/bin/false", log: () => {} });
  box.tick = async () => {};
  const key = "0x" + "ab".repeat(31);
  await assert.rejects(box.setValidator({ operationalAddress: "nope", privateKey: key }), /Starknet address/);
  await assert.rejects(box.setValidator({ operationalAddress: "0x123", privateKey: "0x123" }), /same/);
  await box.setValidator({ operationalAddress: "0xABC", privateKey: key, braavos: true });
  const keyFile = join(dir, "secrets", "operational-key");
  assert.equal(readFileSync(keyFile, "utf8").trim(), key);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const status = JSON.stringify(box.status());
  assert.equal(status.includes(key), false);
  assert.equal(box.status().validator.operationalAddress, "0xabc");
  assert.equal(box.status().validator.braavos, true);
  await box.removeValidator();
  assert.equal(existsSync(keyFile), false);
  assert.equal(box.status().validator.state, "notSetUp");
});

test("Juno is not started without an Ethereum node", () => {
  const dir = mkdtempSync(join(tmpdir(), "stark-"));
  const box = new StarknetBox({ dataDir: dir, log: () => {} });
  assert.equal(box.ethNodeArgs(), null);
  box.l1.url = "ws://ethchain-geth.my.ava.do:8546";
  assert.deepEqual(box.ethNodeArgs(), ["--eth-node", "ws://ethchain-geth.my.ava.do:8546"]);
});

test("an old 'none' setting falls back to automatic: Juno cannot prune without an Ethereum node", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stark-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ l1: "none", fastSync: true }));
  const box = new StarknetBox({ dataDir: dir, log: () => {} });
  box.tick = async () => {};
  assert.equal(box.settings.l1, "auto");
  assert.equal(box.ethNodeArgs(), null);
  await assert.rejects(box.setL1({ l1: "none" }), /Unknown/);
  assert.equal(box.junoProc.build(), null);
  box.l1 = { client: { id: "geth", title: "Geth" }, url: "ws://ethchain-geth.my.ava.do:8546", states: [{ id: "geth", installed: true, answering: true, synced: true }] };
  const args = box.junoProc.build().args;
  assert.equal(args.includes("--disable-l1-verification"), false);
  assert.ok(args.includes("--prune-mode=4500"));
});

test("the custom Ethereum address must be a WebSocket address", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stark-"));
  const box = new StarknetBox({ dataDir: dir, log: () => {} });
  box.tick = async () => {};
  await assert.rejects(box.setL1({ l1: "custom", l1Custom: "http://x:8545" }), /WebSocket/);
  await assert.rejects(box.setL1({ l1: "bogus" }), /Unknown/);
  await box.setL1({ l1: "custom", l1Custom: "wss://example.org/ws" });
  assert.equal(box.settings.l1Custom, "wss://example.org/ws");
});

test("Juno waits while the Ethereum node on the box is still syncing (Juno stops at once otherwise)", () => {
  const dir = mkdtempSync(join(tmpdir(), "stark-"));
  const box = new StarknetBox({ dataDir: dir, log: () => {} });
  box.l1 = { client: { id: "geth", title: "Geth" }, url: "ws://ethchain-geth.my.ava.do:8546", states: [{ id: "geth", installed: true, answering: true, synced: false, progress: 0.4 }] };
  assert.equal(box.l1Ready(), false);
  assert.equal(box.junoProc.build(), null);
  assert.equal(box.status().node.state, "waitingForEthereumSync");
  box.l1.states[0].synced = true;
  assert.equal(box.l1Ready(), true);
  assert.ok(box.junoProc.build().args.includes("--eth-node"));
  assert.equal(box.status().node.state, "starting");
  // the owner's own node is used as it is
  box.settings.l1 = "custom";
  box.l1 = { client: { id: "custom", title: "Your own Ethereum node" }, url: "wss://example.org", states: [] };
  assert.equal(box.l1Ready(), true);
});

test("right after choosing an own Ethereum node, Juno does not start with the old automatic choice", () => {
  const dir = mkdtempSync(join(tmpdir(), "stark-"));
  const box = new StarknetBox({ dataDir: dir, log: () => {} });
  // a check that was already running picked Geth (installed, not answering) ...
  box.l1 = { client: { id: "geth", title: "Geth" }, url: "ws://ethchain-geth.my.ava.do:8546", states: [{ id: "geth", installed: true, answering: false }] };
  // ... when the owner saved their own node
  box.settings.l1 = "custom";
  box.settings.l1Custom = "wss://example.org/ws";
  assert.equal(box.l1Ready(), false);
  assert.equal(box.junoProc.build(), null);
  box.l1 = { client: { id: "custom", title: "Your own Ethereum node" }, url: "wss://example.org/ws", states: [] };
  assert.equal(box.l1Ready(), true);
  const args = box.junoProc.build().args;
  assert.equal(args[args.indexOf("--eth-node") + 1], "wss://example.org/ws");
});

test("a change made while a check runs gets its own check right after", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stark-"));
  const box = new StarknetBox({ dataDir: dir, log: () => {} });
  let calls = 0;
  let release;
  box.refreshL1 = async () => { calls++; if (calls === 1) await new Promise((r) => (release = r)); };
  box.snapshot = {}; // stop each check after refreshL1
  const first = box.tick();
  await box.tick(); // while the first one runs
  assert.equal(calls, 1);
  release();
  await first;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2);
});

test("a node that stopped three times in a row is reported, not shown as starting", () => {
  const dir = mkdtempSync(join(tmpdir(), "stark-"));
  const box = new StarknetBox({ dataDir: dir, log: () => {} });
  box.settings.l1 = "custom";
  box.l1 = { client: { id: "custom", title: "Your own Ethereum node" }, url: "wss://example.org", states: [] };
  box.junoProc.restarts = 3;
  assert.equal(box.status().node.state, "keepsStopping");
  box.junoProc.restarts = 0;
  assert.equal(box.status().node.state, "starting");
});

test("start over brings the fast start back, also after the owner chose to sync from the first block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stark-"));
  const box = new StarknetBox({ dataDir: dir, log: () => {} });
  box.tick = async () => {};
  await box.skipFastStart();
  assert.equal(box.settings.fastSync, false);
  await box.startOver();
  assert.equal(box.settings.fastSync, true);
  assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).fastSync, true);
});
