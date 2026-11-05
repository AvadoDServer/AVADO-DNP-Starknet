// Runs the Starknet node (Juno) and, once the owner has set it up, the
// attestation tool (Nethermind's starknet-staking-v2 validator) in this one
// container, and works out the plain-language status the page shows.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Supervised } from "./lib/proc.mjs";
import { EXECUTION_CLIENTS, jsonRpc, pick, probeExecution } from "./lib/l1.mjs";
import { diskSpace, readJsonFile, removeFile, writeFileAtomic, writeJsonFile } from "./lib/files.mjs";
import { parsePrometheus } from "./lib/metrics.mjs";
import { PRUNED_SNAPSHOT_URL, SnapshotDownload, databaseIsEmpty } from "./snapshot.mjs";

// Mainnet contracts (public). STRK token, and the staking contract the attestation tool also uses.
export const STRK_TOKEN = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
export const STAKING_CONTRACT = "0x00ca1702e64c81d9a07b86bd2c540188d92a2c73cf5cc0e508d949015e7e84a7";
// starknet_keccak of the entry point names
const SELECTOR_BALANCE_OF = "0x35a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33";
const SELECTOR_ATTESTATION_INFO = "0x172b481b04bae5fa5a77efcc44b1aca0a47c83397a952d3dd1c42357575db9f";

export const JUNO_HTTP_PORT = 6060;
export const JUNO_WS_PORT = 6061;
const JUNO_METRICS_PORT = 9091;
const VALIDATOR_METRICS_PORT = 9092;
const RPC = `http://127.0.0.1:${JUNO_HTTP_PORT}/v0_10`;
// Keep about two epochs of blocks: enough for attesting, a fraction of the full database.
const PRUNE_WINDOW = 4500;
// Juno is "in step" when it is this close to the newest block it knows of.
const SYNCED_DISTANCE = 10;

const DEFAULT_SETTINGS = { l1: "auto", l1Custom: "", fastSync: true };

export function isFelt(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value) && !/^0x0+$/.test(value);
}

/** Space separated extra options from the package settings, without any shell parsing. */
export function splitOptions(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean);
}

/** Turns the validator's error lines into one plain sentence, or null. */
export function explainValidatorLine(line) {
  const l = line.toLowerCase();
  if (l.includes("staker does not exist")) return "notStaked";
  if (l.includes("contract not found")) return "accountMissing";
  if (l.includes("below") && l.includes("threshold")) return "lowBalance";
  if (l.includes("insufficient") && (l.includes("balance") || l.includes("fee"))) return "lowBalance";
  if (l.includes("invalid signature") || l.includes("signature") && l.includes("invalid")) return "wrongKey";
  // v0.3.1 prints a WARN about the spec version on every start even when it works; only an error counts
  if (l.includes("json-rpc specification") && !/\bwarn\b/.test(l)) return "rpcVersion";
  return null;
}

export class StarknetBox {
  constructor({ dataDir, junoBin = "juno", validatorBin = "validator", env = process.env, log = console.log, fetchImpl = fetch }) {
    this.dataDir = dataDir;
    this.junoDir = join(dataDir, "juno");
    this.settingsPath = join(dataDir, "settings.json");
    this.validatorPath = join(dataDir, "validator.json");
    this.keyPath = join(dataDir, "secrets", "operational-key");
    this.env = env;
    this.log = log;
    this.fetch = fetchImpl;
    mkdirSync(dataDir, { recursive: true });
    this.settings = { ...DEFAULT_SETTINGS, ...readJsonFile(this.settingsPath, {}) };
    // "none" (no Ethereum check) was offered by an early test build; Juno refuses to prune without it
    if (!["auto", "custom", ...EXECUTION_CLIENTS.map((c) => c.id)].includes(this.settings.l1)) this.settings.l1 = "auto";
    this.validatorConfig = readJsonFile(this.validatorPath, null);
    this.l1 = { client: null, url: null, states: [], checkedAt: null };
    this.juno = { synced: false, block: null, highest: null, version: null, checkedAt: null, everSynced: false };
    this.junoStartUrl = undefined;
    this.validatorProblem = null;
    this.validatorMetrics = null;
    this.account = null;
    this.snapshot = null;
    this.snapshotError = null;
    this.timer = null;

    this.junoProc = new Supervised({
      name: "juno",
      stopTimeoutMs: 120000,
      // Juno 0.17.0 briefly opens a "migration status" server on its RPC port at every start; now and
      // then its RPC server then finds the port taken and Juno stops at once. Starting again fixes it.
      quickRetry: /bind: address already in use/,
      build: () => {
        const eth = this.ethNodeArgs();
        if (!eth || !this.l1Ready()) return null;
        this.junoStartUrl = this.l1.url;
        return {
          cmd: junoBin,
          args: [
            "--network", "mainnet",
            "--db-path", this.junoDir,
            "--http", "--http-host", "0.0.0.0", "--http-port", String(JUNO_HTTP_PORT),
            "--ws", "--ws-host", "0.0.0.0", "--ws-port", String(JUNO_WS_PORT),
            "--metrics", "--metrics-host", "127.0.0.1", "--metrics-port", String(JUNO_METRICS_PORT),
            `--prune-mode=${PRUNE_WINDOW}`,
            ...eth,
            ...splitOptions(env.JUNO_EXTRA_OPTS),
          ],
          env: { PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: dataDir },
        };
      },
    });

    this.validatorProc = new Supervised({
      name: "validator",
      secrets: () => [this.readKey()],
      onLine: (line) => {
        const problem = explainValidatorLine(line);
        if (problem) this.validatorProblem = { problem, line, at: Date.now() };
        else if (/attestation .*(successful|confirmed|submitted)/i.test(line)) this.validatorProblem = null;
      },
      build: () => {
        const cfg = this.validatorConfig;
        const key = this.readKey();
        if (!cfg || !key) return null;
        return {
          cmd: validatorBin,
          args: [
            "--provider-http", RPC,
            "--provider-ws", `ws://127.0.0.1:${JUNO_WS_PORT}/v0_10`,
            "--signer-op-address", cfg.operationalAddress,
            "--metrics", "--metrics-host", "127.0.0.1", "--metrics-port", String(VALIDATOR_METRICS_PORT),
            ...(cfg.braavos ? ["--braavos-account"] : []),
            ...splitOptions(env.VALIDATOR_EXTRA_OPTS),
          ],
          // the key goes in the environment, never on the command line (visible to every process)
          env: { PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin", SIGNER_PRIVATE_KEY: key },
        };
      },
    });
  }

  readKey() {
    try {
      return readFileSync(this.keyPath, "utf8").trim();
    } catch {
      return "";
    }
  }

  /** Juno's L1 arguments, or null when there is no Ethereum node to use yet. */
  ethNodeArgs() {
    if (!this.l1.url) return null;
    return ["--eth-node", this.l1.url];
  }

  /**
   * True when Juno can use the Ethereum node now: the owner's own node, or one on this AVADO that has
   * finished syncing. Juno 0.17 with --prune-mode stops at once ("finalized block not found") while the
   * Ethereum node is still syncing, so it waits instead of restarting in a loop.
   */
  l1Ready() {
    if (!this.l1.url) return false;
    // the owner's own node, once this.l1 has been refreshed to it (right after the owner saves the
    // choice, a check that was already running can still hold the old, automatic choice)
    if (this.settings.l1 === "custom") return this.l1.client?.id === "custom";
    const st = this.l1.client ? this.l1.states.find((x) => x.id === this.l1.client.id) : null;
    return !!(st && st.answering && st.synced === true);
  }

  saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    writeJsonFile(this.settingsPath, this.settings);
  }

  async refreshL1() {
    const s = this.settings;
    if (s.l1 === "custom") {
      this.l1 = { client: { id: "custom", title: "Your own Ethereum node" }, url: s.l1Custom || null, states: [], checkedAt: Date.now() };
      return;
    }
    const { client, states } = await pick(EXECUTION_CLIENTS, probeExecution, s.l1);
    const state = client ? states.find((x) => x.id === client.id) : null;
    this.l1 = {
      client: client ? { id: client.id, title: client.title } : null,
      // only use a client that is installed
      url: client && state && state.installed ? client.ws : null,
      states,
      checkedAt: Date.now(),
    };
  }

  async refreshJuno() {
    if (!this.junoProc.running) {
      this.juno.synced = false;
      this.juno.answering = false;
      return;
    }
    try {
      const syncing = await jsonRpc(RPC, "starknet_syncing", [], 5000);
      const block = await jsonRpc(RPC, "starknet_blockNumber", [], 5000).catch(() => null);
      if (syncing === false) {
        this.juno.block = block;
        this.juno.highest = block;
        this.juno.synced = block !== null;
      } else if (syncing && typeof syncing === "object") {
        this.juno.block = Number(syncing.current_block_num);
        this.juno.highest = Number(syncing.highest_block_num);
        this.juno.synced = this.juno.highest - this.juno.block <= SYNCED_DISTANCE;
      }
      if (this.juno.synced) this.juno.everSynced = true;
      if (!this.juno.version) this.juno.version = await jsonRpc(`http://127.0.0.1:${JUNO_HTTP_PORT}`, "juno_version", [], 3000).catch(() => null);
      this.juno.answering = true;
    } catch {
      this.juno.answering = false;
      this.juno.synced = false;
    }
    this.juno.checkedAt = Date.now();
  }

  async refreshValidator() {
    if (!this.validatorProc.running) {
      this.validatorMetrics = null;
      return;
    }
    try {
      const res = await this.fetch(`http://127.0.0.1:${VALIDATOR_METRICS_PORT}/metrics`, { signal: AbortSignal.timeout(3000) });
      const m = parsePrometheus(await res.text());
      this.validatorMetrics = {
        epoch: m.validator_attestation_current_epoch_id ?? null,
        assignedBlock: m.validator_attestation_current_epoch_assigned_block_number ?? null,
        latestBlock: m.validator_attestation_starknet_latest_block_number ?? null,
        lastAttestation: m.validator_attestation_last_attestation_timestamp_seconds
          ? m.validator_attestation_last_attestation_timestamp_seconds * 1000
          : null,
        submitted: m.validator_attestation_attestation_submitted_count ?? 0,
        confirmed: m.validator_attestation_attestation_confirmed_count ?? 0,
        failed: m.validator_attestation_attestation_failure_count ?? 0,
        belowThreshold: m.validator_attestation_signer_below_threshold === 1,
      };
    } catch {
      this.validatorMetrics = null;
    }
  }

  /** Checks the operational account on Starknet through the box's own node (read only). */
  async refreshAccount() {
    const cfg = this.validatorConfig;
    if (!cfg || !this.juno.synced) {
      this.account = null;
      return;
    }
    const out = { address: cfg.operationalAddress, deployed: null, strk: null, staked: null, stake: null, stakerAddress: null, checkedAt: Date.now() };
    try {
      await jsonRpc(RPC, "starknet_getClassHashAt", { block_id: "latest", contract_address: cfg.operationalAddress }, 5000);
      out.deployed = true;
    } catch (err) {
      if (err.code === 20) out.deployed = false;
    }
    try {
      const r = await jsonRpc(RPC, "starknet_call", {
        request: { contract_address: STRK_TOKEN, entry_point_selector: SELECTOR_BALANCE_OF, calldata: [cfg.operationalAddress] },
        block_id: "latest",
      }, 5000);
      out.strk = Number(BigInt(r[0]) + (BigInt(r[1] || 0) << 128n)) / 1e18;
    } catch {
      // leave unknown
    }
    try {
      const r = await jsonRpc(RPC, "starknet_call", {
        request: { contract_address: STAKING_CONTRACT, entry_point_selector: SELECTOR_ATTESTATION_INFO, calldata: [cfg.operationalAddress] },
        block_id: "latest",
      }, 5000);
      out.staked = true;
      out.stakerAddress = r[0];
      out.stake = Number(BigInt(r[1])) / 1e18;
    } catch (err) {
      if (/staker does not exist/i.test(JSON.stringify(err.data || "") + String(err.message || ""))) out.staked = false;
    }
    this.account = out;
  }

  startSnapshot() {
    const disk = diskSpace(this.dataDir);
    const dl = new SnapshotDownload({ url: this.env.SNAPSHOT_URL || PRUNED_SNAPSHOT_URL, target: this.junoDir, log: this.log });
    this.snapshot = dl;
    this.snapshotError = null;
    (async () => {
      try {
        const { total } = await dl.head();
        // the unpacked database is a little larger than the download
        if (disk && total && disk.free < total * 1.4) {
          throw new Error(`not enough free disk space: ${(total * 1.4 / 1e9).toFixed(0)} GB needed, ${(disk.free / 1e9).toFixed(0)} GB free`);
        }
        await dl.run();
        this.snapshot = null;
        this.tick();
      } catch (err) {
        if (dl.state === "cancelled") {
          this.snapshot = null;
          return;
        }
        this.snapshotError = { message: err.message, at: Date.now() };
        this.snapshot = null;
      }
    })();
  }

  /** One round of "what should be running now". Called every 15 seconds and after every change. */
  async tick() {
    if (this.ticking) {
      // a change made during a running check (a new Ethereum choice) is applied right after it
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      await this.refreshL1();
      if (this.snapshot) return;
      const empty = databaseIsEmpty(this.junoDir);
      if (empty && this.settings.fastSync && !this.junoProc.running) {
        // Juno cannot run without an Ethereum node: the large download (about 100 GB) waits until
        // one is found on the box or the owner sets their own
        if (!this.l1.url) return;
        // after a failure, try again at most every 30 minutes
        if (!this.snapshotError || Date.now() - this.snapshotError.at > 30 * 60 * 1000) this.startSnapshot();
        return;
      }
      if (!existsSync(this.junoDir)) mkdirSync(this.junoDir, { recursive: true });

      if (this.junoProc.running && this.junoStartUrl !== this.l1.url) {
        this.log(`Ethereum node changed, restarting Juno`);
        await this.junoProc.restart();
      } else if (!this.junoProc.running && this.l1Ready()) {
        this.junoProc.start();
      }

      await this.refreshJuno();
      const ready = this.validatorConfig && this.readKey();
      if (ready && this.juno.everSynced && this.junoProc.running) this.validatorProc.start();
      if (!ready && this.validatorProc.running) await this.validatorProc.stop();
      await this.refreshValidator();
      if (!this.account || Date.now() - this.account.checkedAt > 5 * 60 * 1000) await this.refreshAccount();
    } catch (err) {
      this.log(`check failed: ${err.message}`);
    } finally {
      this.ticking = false;
      if (this.tickAgain) {
        this.tickAgain = false;
        setTimeout(() => this.tick(), 0);
      }
    }
  }

  begin() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 15000);
  }

  async shutdown() {
    clearInterval(this.timer);
    if (this.snapshot) this.snapshot.cancel();
    await this.validatorProc.stop();
    await this.junoProc.stop();
  }

  // ---- actions from the page ----

  async setValidator({ operationalAddress, privateKey, braavos }) {
    if (!isFelt(operationalAddress)) throw Object.assign(new Error("That does not look like a Starknet address. It starts with 0x."), { status: 400 });
    if (!isFelt(privateKey)) throw Object.assign(new Error("That does not look like a private key. It starts with 0x."), { status: 400 });
    if (privateKey.toLowerCase() === operationalAddress.toLowerCase()) {
      throw Object.assign(new Error("The private key and the address are the same. Copy the private key from your wallet."), { status: 400 });
    }
    await this.validatorProc.stop();
    writeFileAtomic(this.keyPath, privateKey.trim() + "\n", 0o600);
    this.validatorConfig = { operationalAddress: operationalAddress.toLowerCase(), braavos: braavos === true, savedAt: Date.now() };
    writeJsonFile(this.validatorPath, this.validatorConfig);
    this.validatorProblem = null;
    this.account = null;
    this.tick();
  }

  async removeValidator() {
    await this.validatorProc.stop();
    removeFile(this.keyPath);
    removeFile(this.validatorPath);
    this.validatorConfig = null;
    this.validatorProblem = null;
    this.validatorMetrics = null;
    this.account = null;
  }

  async setL1({ l1, l1Custom }) {
    // Juno always checks against an Ethereum node: its pruning (which keeps the database small) needs it
    const allowed = ["auto", "custom", ...EXECUTION_CLIENTS.map((c) => c.id)];
    if (!allowed.includes(l1)) throw Object.assign(new Error("Unknown choice"), { status: 400 });
    if (l1 === "custom" && !/^wss?:\/\/[^\s]+$/.test(l1Custom || "")) {
      throw Object.assign(new Error("Enter a WebSocket address that starts with ws:// or wss://"), { status: 400 });
    }
    this.saveSettings({ l1, l1Custom: l1 === "custom" ? l1Custom : "" });
    await this.tick();
  }

  async skipFastStart() {
    if (this.snapshot) this.snapshot.cancel();
    this.snapshot = null;
    this.saveSettings({ fastSync: false });
    setTimeout(() => this.tick(), 1000);
  }

  async useFastStart() {
    this.saveSettings({ fastSync: true });
    this.snapshotError = null;
    this.tick();
  }

  /** Removes the Starknet database and downloads a fresh copy (or syncs from the start). */
  async startOver() {
    if (this.snapshot) this.snapshot.cancel();
    this.snapshot = null;
    await this.validatorProc.stop();
    await this.junoProc.stop();
    const { rmSync } = await import("node:fs");
    rmSync(this.junoDir, { recursive: true, force: true });
    this.juno = { synced: false, block: null, highest: null, version: null, checkedAt: null, everSynced: false };
    this.snapshotError = null;
    // "Start over" promises a fresh copy, also after the owner once chose to sync from the first block
    this.saveSettings({ fastSync: true });
    this.tick();
  }

  async restartNode() {
    await this.validatorProc.stop();
    await this.junoProc.restart();
  }

  status() {
    const cfg = this.validatorConfig;
    const snap = this.snapshot ? this.snapshot.status() : null;
    let node;
    if (snap) node = "downloading";
    else if (this.snapshotError && databaseIsEmpty(this.junoDir) && this.settings.fastSync) node = "downloadFailed";
    else if (!this.junoProc.running && !this.ethNodeArgs()) node = "waitingForEthereum";
    else if (!this.junoProc.running && !this.l1Ready()) node = "waitingForEthereumSync";
    // it stopped three times in a row: say so instead of "starting" for ever
    else if (this.junoProc.restarts >= 3 && !this.juno.answering) node = "keepsStopping";
    else if (!this.junoProc.running) node = "starting";
    else if (!this.juno.answering) node = "starting";
    else if (this.juno.synced) node = "synced";
    else node = "syncing";

    let validator;
    if (!cfg) validator = "notSetUp";
    else if (!this.validatorProc.running) validator = this.juno.everSynced ? "starting" : "waitingForNode";
    else if (this.validatorProblem) validator = "problem";
    else validator = "running";

    return {
      packageVersion: this.env.PACKAGE_VERSION || null,
      node: {
        state: node,
        block: this.juno.block,
        highest: this.juno.highest,
        version: this.juno.version,
        snapshot: snap,
        snapshotError: this.snapshotError,
        fastSync: this.settings.fastSync,
        restarts: this.junoProc.restarts,
      },
      ethereum: {
        choice: this.settings.l1,
        custom: this.settings.l1Custom,
        using: this.l1.client,
        url: this.l1.url,
        clients: this.l1.states,
      },
      validator: {
        state: validator,
        operationalAddress: cfg ? cfg.operationalAddress : null,
        braavos: cfg ? cfg.braavos : false,
        problem: this.validatorProblem ? this.validatorProblem.problem : null,
        problemLine: this.validatorProblem ? this.validatorProblem.line : null,
        metrics: this.validatorMetrics,
        account: this.account,
      },
      disk: diskSpace(this.dataDir),
    };
  }

  logs(which) {
    return which === "validator" ? this.validatorProc.tail(200) : this.junoProc.tail(200);
  }
}
