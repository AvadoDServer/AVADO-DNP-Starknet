// Finds the Ethereum (L1) node on this AVADO. Package names, host names and
// ports are the ones the AVADO client packages use (same list as the Rocket Pool
// package's resolve_client_urls and the Client UI's executionClients.ts).
// A package that is not installed has no *.my.ava.do name, so a failed DNS
// lookup means "not installed".
import { lookup } from "node:dns/promises";

export const EXECUTION_CLIENTS = [
  {
    id: "geth",
    title: "Geth",
    packageName: "ethchain-geth.public.dappnode.eth",
    http: "http://ethchain-geth.my.ava.do:8545",
    ws: "ws://ethchain-geth.my.ava.do:8546",
  },
  {
    id: "nethermind",
    title: "Nethermind",
    packageName: "avado-dnp-nethermind.public.dappnode.eth",
    http: "http://avado-dnp-nethermind.my.ava.do:8545",
    ws: "ws://avado-dnp-nethermind.my.ava.do:8545",
  },
  {
    id: "reth",
    title: "Reth",
    http: "http://reth-mainnet.my.ava.do:8545",
    ws: "ws://reth-mainnet.my.ava.do:8546",
  },
];

export const CONSENSUS_CLIENTS = [
  { id: "teku", title: "Teku", http: "http://teku.my.ava.do:5051" },
  { id: "nimbus", title: "Nimbus", http: "http://nimbus.my.ava.do:5052" },
  { id: "lighthouse", title: "Lighthouse", http: "http://lighthouse.my.ava.do:5052" },
  { id: "prysm", title: "Prysm", http: "http://prysm-beacon-chain-mainnet.my.ava.do:3500" },
];

const TIMEOUT_MS = 4000;

async function resolves(url) {
  try {
    await lookup(new URL(url).hostname);
    return true;
  } catch {
    return false;
  }
}

export async function jsonRpc(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`answered with HTTP ${res.status}`);
  }
  if (body.error) {
    const e = new Error(body.error.message || "error");
    e.code = body.error.code;
    e.data = body.error.data;
    throw e;
  }
  return body.result;
}

/** State of one execution client: installed, answering, chain, syncing. */
export async function probeExecution(client) {
  const out = { id: client.id, title: client.title, installed: false, answering: false, mainnet: null, synced: null };
  if (!(await resolves(client.http))) return out;
  out.installed = true;
  try {
    const chainId = await jsonRpc(client.http, "eth_chainId");
    out.answering = true;
    out.mainnet = chainId === "0x1";
    const syncing = await jsonRpc(client.http, "eth_syncing");
    out.synced = syncing === false;
    if (syncing && typeof syncing === "object" && syncing.highestBlock) {
      const cur = parseInt(syncing.currentBlock, 16);
      const high = parseInt(syncing.highestBlock, 16);
      if (high > 0) out.progress = Math.min(1, cur / high);
    }
  } catch {
    // installed but not answering (starting, stopped)
  }
  return out;
}

/** State of one beacon node. */
export async function probeConsensus(client) {
  const out = { id: client.id, title: client.title, installed: false, answering: false, synced: null };
  if (!(await resolves(client.http))) return out;
  out.installed = true;
  try {
    const res = await fetch(`${client.http}/eth/v1/node/syncing`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return out;
    const body = await res.json();
    out.answering = true;
    out.synced = body?.data?.is_syncing === false && body?.data?.el_offline !== true;
  } catch {
    // not answering
  }
  return out;
}

/**
 * Picks a client: the one the owner chose, otherwise the first installed one that
 * is synced, otherwise the first installed one. Returns {client, states}.
 */
export async function pick(list, probe, chosenId) {
  const states = await Promise.all(list.map((c) => probe(c)));
  const byId = (id) => list.find((c) => c.id === id);
  if (chosenId && chosenId !== "auto") {
    const c = byId(chosenId);
    return { client: c || null, states };
  }
  const installed = states.filter((s) => s.installed);
  const best = installed.find((s) => s.synced) || installed.find((s) => s.answering) || installed[0];
  return { client: best ? byId(best.id) : null, states };
}
