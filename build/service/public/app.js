// AVADO Starknet Validator page. Reads /api/status every 5 seconds and shows it in plain words.
"use strict";

const $ = (id) => document.getElementById(id);
let last = null;

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json", "x-avado-request": "1" },
    body: JSON.stringify(body),
  };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The box answered ${res.status}`);
  return data;
}

function show(id, on) {
  $(id).hidden = !on;
}

function gb(bytes) {
  return bytes == null ? "…" : `${(bytes / 1e9).toFixed(bytes > 1e11 ? 0 : 1)} GB`;
}

function ago(ms) {
  if (!ms) return "not yet";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s} seconds ago`;
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 172800) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function strk(n) {
  if (n == null) return "…";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 3 : 0 })} STRK`;
}

const PROBLEMS = {
  notStaked: "This attestation account is not linked to a stake yet. Stake at least 20,000 STRK from your main account with this account as the operational address (step 3). The validator starts attesting by itself in the epoch after the stake.",
  accountMissing: "This attestation account does not exist on Starknet yet. Send it some STRK and make one transaction with it in your wallet, so the wallet deploys it.",
  lowBalance: "The attestation account is running low on STRK. Send it some STRK so it can keep paying the fees.",
  wrongKey: "Starknet refused the signature. Check that the private key belongs to this attestation account, and tick “Braavos account” if it is one.",
  rpcVersion: "The validator and the Starknet node do not speak the same version. Update this package.",
};

function nodeText(s) {
  const n = s.node;
  switch (n.state) {
    case "downloading": return "Downloading a recent copy";
    case "downloadFailed": return "Download stopped";
    case "waitingForEthereum": return "Waiting for an Ethereum node";
    case "starting": return "Starting";
    case "syncing": return n.block != null && n.highest ? `Catching up (block ${n.block.toLocaleString()} of ${n.highest.toLocaleString()})` : "Catching up";
    case "synced": return `Up to date (block ${Number(n.block).toLocaleString()})`;
    default: return n.state;
  }
}

function ethText(s) {
  const e = s.ethereum;
  if (e.choice === "none") return "None (trusting the Starknet servers)";
  if (!e.using) return "None found";
  const st = (e.clients || []).find((c) => c.id === e.using.id);
  if (e.using.id === "custom") return e.custom || "Not set";
  if (!st || !st.installed) return `${e.using.title} (not installed)`;
  if (!st.answering) return `${e.using.title} (not answering)`;
  if (st.mainnet === false) return `${e.using.title} (not on Ethereum mainnet)`;
  if (st.synced === false) return `${e.using.title} (still syncing${st.progress ? `, ${Math.floor(st.progress * 100)}%` : ""})`;
  return e.using.title;
}

function validatorText(s) {
  const v = s.validator;
  switch (v.state) {
    case "notSetUp": return "Not set up";
    case "waitingForNode": return "Waits for the node to be up to date";
    case "starting": return "Starting";
    case "problem": return "Needs your attention";
    case "running": return v.metrics && v.metrics.lastAttestation ? "Attesting" : "Running";
    default: return v.state;
  }
}

function verdict(s) {
  const n = s.node.state;
  const v = s.validator;
  if (n === "waitingForEthereum") return ["warning", "Install an Ethereum node first", "Your Starknet node needs Geth or Nethermind on this AVADO."];
  if (n === "downloadFailed") return ["warning", "The fast start download stopped", s.node.snapshotError ? s.node.snapshotError.message : ""];
  if (n === "downloading") {
    const sn = s.node.snapshot;
    const pct = sn && sn.total ? Math.floor((sn.bytes / sn.total) * 100) : 0;
    const noEth = !s.ethereum.using && s.ethereum.choice !== "none";
    return [noEth ? "warning" : "unknown", `Setting up your Starknet node (${pct}%)`,
      "Downloading a recent copy of Starknet. This takes a few hours, depending on your internet connection." + (noEth ? " Install an Ethereum node meanwhile (see below)." : "")];
  }
  if (n !== "synced") return ["unknown", "Your Starknet node is catching up", "This can take a while. You can already set up your validator below."];
  if (v.state === "problem") return ["warning", "Your validator needs attention", PROBLEMS[v.problem] || "See “Your validator” below."];
  if (v.account && v.account.staked === false) return ["warning", "Your validator is not staked yet", PROBLEMS.notStaked];
  if (v.account && v.account.deployed === false) return ["warning", "Your attestation account is not on Starknet yet", PROBLEMS.accountMissing];
  if (v.state === "notSetUp") return ["ok", "Your Starknet node is up to date", "Set up your validator below to start earning STRK."];
  if (v.metrics && v.metrics.belowThreshold) return ["warning", "Top up your attestation account", PROBLEMS.lowBalance];
  const lastAt = v.metrics && v.metrics.lastAttestation;
  if (lastAt && Date.now() - lastAt < 3 * 3600 * 1000) return ["ok", "Your validator is attesting", `Last attestation ${ago(lastAt)}.`];
  return ["ok", "Your validator is running", "It attests once per epoch, when its turn comes."];
}

function render(s) {
  last = s;
  $("version").textContent = s.packageVersion ? `version ${s.packageVersion}` : "";
  const [level, head, sub] = verdict(s);
  $("verdict").dataset.level = level;
  $("headline").textContent = head;
  $("subline").textContent = sub;

  $("f-node").textContent = nodeText(s);
  $("f-eth").textContent = ethText(s);
  $("f-validator").textContent = validatorText(s);
  $("f-disk").textContent = s.disk ? `${gb(s.disk.free)} of ${gb(s.disk.total)}` : "…";
  $("juno-version").textContent = s.node.version ? `Juno ${s.node.version}.` : "";

  const syncing = s.node.state === "syncing" && s.node.highest > 0;
  show("sync-progress", syncing);
  if (syncing) {
    const left = s.node.highest - s.node.block;
    $("sync-text").textContent = `${left.toLocaleString()} blocks to go.`;
    $("sync-bar").style.width = `${Math.floor((s.node.block / s.node.highest) * 100)}%`;
  }

  const sn = s.node.snapshot;
  show("fast-start", s.node.state === "downloading");
  if (sn) {
    const pct = sn.total ? (sn.bytes / sn.total) * 100 : 0;
    const secs = (Date.now() - sn.startedAt) / 1000;
    const rate = secs > 30 ? sn.bytes / secs : 0;
    const eta = rate && sn.total ? (sn.total - sn.bytes) / rate : 0;
    $("fast-text").textContent = `${gb(sn.bytes)} of ${gb(sn.total)} (${pct.toFixed(1)}%)` +
      (rate ? `, about ${eta > 5400 ? `${Math.round(eta / 3600)} hours` : `${Math.max(1, Math.round(eta / 60))} minutes`} left` : "");
    $("fast-bar").style.width = `${pct}%`;
  }
  show("fast-failed", s.node.state === "downloadFailed");
  if (s.node.snapshotError) $("fast-failed-text").textContent = s.node.snapshotError.message;
  // also while the fast start downloads: the node can only start once an Ethereum node is there
  show("need-eth", s.node.state === "waitingForEthereum" || (!s.ethereum.using && s.ethereum.choice !== "none"));

  const v = s.validator;
  const editing = $("v-setup").dataset.editing === "1";
  show("v-setup", v.state === "notSetUp" || editing);
  show("v-running", v.state !== "notSetUp" && !editing);
  if (v.state !== "notSetUp") {
    $("v-addr").textContent = v.operationalAddress;
    const a = v.account;
    $("v-stake").textContent = !a ? "Checked when the node is up to date" : a.staked ? strk(a.stake) : a.staked === false ? "None yet" : "…";
    $("v-strk").textContent = !a ? "…" : a.deployed === false ? "Account not deployed yet" : strk(a.strk);
    const m = v.metrics;
    $("v-last").textContent = m ? ago(m.lastAttestation) : "…";
    $("v-count").textContent = m ? `${m.confirmed} confirmed, ${m.submitted} sent, ${m.failed} failed` : "…";
    $("v-epoch").textContent = m && m.epoch != null ? String(m.epoch) : "…";
    const problem = v.state === "problem" ? PROBLEMS[v.problem] : a && a.staked === false ? PROBLEMS.notStaked : a && a.deployed === false ? PROBLEMS.accountMissing : null;
    show("v-problem", !!problem);
    if (problem) $("v-problem").textContent = problem;
  }

  const choice = $("eth-choice");
  if (document.activeElement !== choice && !choice.dataset.touched) {
    choice.value = s.ethereum.choice;
    $("eth-custom").value = s.ethereum.custom || "";
    show("eth-custom-field", choice.value === "custom");
  }
}

async function refresh() {
  try {
    render(await api("/api/status"));
    show("page-error", false);
  } catch (err) {
    $("page-error").textContent = `Cannot reach the box: ${err.message}`;
    show("page-error", true);
  }
}

async function loadLogs(which) {
  try {
    const { lines } = await api(`/api/logs?which=${which}`);
    $(`log-${which}`).textContent = lines.join("\n") || "Nothing yet.";
  } catch (err) {
    $(`log-${which}`).textContent = err.message;
  }
}

function on(id, event, fn) {
  $(id).addEventListener(event, fn);
}

on("v-form", "submit", async (e) => {
  e.preventDefault();
  $("v-save").disabled = true;
  $("v-msg").textContent = "Saving…";
  try {
    await api("/api/validator", {
      operationalAddress: $("v-address").value.trim(),
      privateKey: $("v-key").value.trim(),
      braavos: $("v-braavos").checked,
    });
    $("v-key").value = "";
    $("v-msg").textContent = "Saved.";
    $("v-setup").dataset.editing = "0";
    refresh();
  } catch (err) {
    $("v-msg").textContent = err.message;
  } finally {
    $("v-save").disabled = false;
  }
});

on("v-change", "click", () => {
  $("v-setup").dataset.editing = "1";
  $("v-address").value = last && last.validator.operationalAddress ? last.validator.operationalAddress : "";
  $("v-braavos").checked = !!(last && last.validator.braavos);
  if (last) render(last);
});

on("v-remove", "click", async () => {
  const typed = window.prompt("This stops attesting and removes the attestation account's key from the box. Your stake is not touched. Type REMOVE to confirm.");
  if (typed === null) return;
  try {
    await api("/api/validator/remove", { confirm: typed.trim() });
    refresh();
  } catch (err) {
    window.alert(err.message);
  }
});

on("eth-choice", "change", () => {
  $("eth-choice").dataset.touched = "1";
  show("eth-custom-field", $("eth-choice").value === "custom");
});

on("eth-form", "submit", async (e) => {
  e.preventDefault();
  $("eth-msg").textContent = "Saving…";
  try {
    await api("/api/ethereum", { l1: $("eth-choice").value, l1Custom: $("eth-custom").value.trim() });
    delete $("eth-choice").dataset.touched;
    $("eth-msg").textContent = "Saved. The Starknet node restarts with the new choice.";
    refresh();
  } catch (err) {
    $("eth-msg").textContent = err.message;
  }
});

async function skipFast() {
  if (!window.confirm("Syncing from the first block takes weeks and the validator can only start when it is done. Continue?")) return;
  await api("/api/fast-start/skip", {}).catch((err) => window.alert(err.message));
  refresh();
}
on("fast-skip", "click", skipFast);
on("fast-skip2", "click", skipFast);
on("fast-retry", "click", async () => {
  await api("/api/fast-start/use", {}).catch((err) => window.alert(err.message));
  refresh();
});

on("over-form", "submit", async (e) => {
  e.preventDefault();
  $("over-msg").textContent = "";
  try {
    await api("/api/node/start-over", { confirm: $("over-confirm").value.trim() });
    $("over-confirm").value = "";
    $("over-msg").textContent = "Started over.";
    refresh();
  } catch (err) {
    $("over-msg").textContent = err.message;
  }
});

on("node-restart", "click", async () => {
  $("over-msg").textContent = "Restarting…";
  try {
    await api("/api/node/restart", {});
    $("over-msg").textContent = "Restarted.";
  } catch (err) {
    $("over-msg").textContent = err.message;
  }
});

for (const which of ["node", "validator"]) {
  $(`log-${which}`).closest("details").addEventListener("toggle", (e) => {
    if (e.target.open) loadLogs(which);
  });
}

refresh();
setInterval(refresh, 5000);
