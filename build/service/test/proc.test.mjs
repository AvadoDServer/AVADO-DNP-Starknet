import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, Supervised } from "../src/lib/proc.mjs";

test("redact hides keys, known secrets and recovery phrases", () => {
  assert.equal(redact("signer key 0xabc123def4567890", ["0xabc123def4567890"]), "signer key [hidden]");
  assert.match(redact('privateKey: "0x1234567890abcdef"'), /\[hidden\]/);
  assert.doesNotMatch(redact("SIGNER_PRIVATE_KEY=0xdeadbeefdeadbeef"), /deadbeef/);
  const phrase = "option moral foam lawsuit girl verb mango hour isolate flame symbol silly";
  assert.doesNotMatch(redact(`Using new mnemonic: ${phrase}`), /lawsuit/);
  assert.equal(redact("Stored Block number 345"), "Stored Block number 345");
});

test("supervised program: runs, keeps its log, stops", async () => {
  const p = new Supervised({
    name: "t",
    build: () => ({ cmd: process.execPath, args: ["-e", "console.log('hello'); setInterval(() => {}, 1000)"], env: {} }),
  });
  p.start();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(p.running, true);
  assert.deepEqual(p.tail(), ["hello"]);
  await p.stop();
  assert.equal(p.running, false);
});

test("supervised program: build() returning null means do not start", () => {
  const p = new Supervised({ name: "t", build: () => null });
  p.start();
  assert.equal(p.running, false);
  assert.equal(p.wanted, false);
});

test("supervised program: a known start-up hiccup is retried after 1 s without counting as a failure", async () => {
  let runs = 0;
  const p = new Supervised({
    name: "t",
    quickRetry: /address already in use/,
    build: () => {
      runs += 1;
      const script = runs < 3 ? "console.log('listen tcp 0.0.0.0:6060: bind: address already in use')" : "setInterval(() => {}, 1000)";
      return { cmd: process.execPath, args: ["-e", script], env: {} };
    },
  });
  p.start();
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(runs, 3);
  assert.equal(p.running, true);
  assert.equal(p.restarts, 0);
  await p.stop();
});

test("supervised program: other stops still count and back off", async () => {
  const p = new Supervised({
    name: "t",
    quickRetry: /address already in use/,
    build: () => ({ cmd: process.execPath, args: ["-e", "console.log('some other error')"], env: {} }),
  });
  p.start();
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(p.restarts, 1);
  await p.stop();
});
