#!/usr/bin/env node
/**
 * Photo Task Escrow — demo driver (GenLayer Studio Next, chain 61997).
 *
 * Runs two full deals end-to-end against the deployed PhotoTaskEscrow
 * contract:
 *   Deal A — matching photo (Eiffel Tower at night)  -> verdict: release
 *   Deal B — mismatching photo (Colosseum)           -> verdict: refund
 *
 * Each deal: create_task (1 GEN escrow, payable) -> submit_photo ->
 * judge (validator jury) -> read verdict + balances.
 *
 * Actors are fresh local keys stored in `.env` (gitignored, mode 0600),
 * funded with test GEN via the Studio `sim_fundAccount` RPC. No real
 * money, no mainnet spend, no user wallets.
 *
 * Usage:
 *   node scripts/demo.mjs            # both deals
 *   node scripts/demo.mjs A          # deal A only
 *   node scripts/demo.mjs B          # deal B only
 *   CONTRACT_ADDRESS=0x... node scripts/demo.mjs
 */
import {
  createClient,
  createAccount,
  generatePrivateKey,
  chains,
} from "genlayer-js";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";

const RPC = "https://studio-dev.genlayer.com/api";
const EXPLORER = "https://explorer-studio-dev.genlayer.com";
const CONTRACT =
  process.env.CONTRACT_ADDRESS ||
  (existsSync(".contract-address")
    ? readFileSync(".contract-address", "utf8").trim()
    : "");
if (!/^0x[0-9a-fA-F]{40}$/.test(CONTRACT)) {
  console.error(
    "No contract address. Deploy first (see README) or set CONTRACT_ADDRESS.",
  );
  process.exit(1);
}
const ONE_GEN = 10n ** 18n;

const client = createClient({ chain: chains.studioDevnet });

/* ------------------------------------------------------------------ */
/* Actor accounts                                                      */
/* ------------------------------------------------------------------ */

function loadEnv() {
  const env = {};
  if (existsSync(".env")) {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)=(.*)\s*$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

async function fund(address, amountWei) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sim_fundAccount",
      params: [address, "0x" + amountWei.toString(16)],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`sim_fundAccount failed: ${JSON.stringify(json.error)}`);
}

async function getActor(name, env) {
  const keyName = `DEMO_${name}_KEY`;
  let key = env[keyName];
  if (!key) {
    key = generatePrivateKey();
    env[keyName] = key;
    envDirty = true;
    const account = createAccount(key);
    await fund(account.address, 100n * ONE_GEN);
    console.log(`[${name}] new account ${account.address} funded with 100 test GEN`);
  }
  return createAccount(key);
}

const env = loadEnv();
let envDirty = false;
const requester = await getActor("REQUESTER", env);
const contributor = await getActor("CONTRIBUTOR", env);
if (!existsSync(".env") || envDirty) {
  writeFileSync(
    ".env",
    `# Demo actor keys — TEST GEN only, Studio Next (61997). NEVER use on mainnet.\n` +
      `DEMO_REQUESTER_KEY=${env.DEMO_REQUESTER_KEY}\n` +
      `DEMO_CONTRIBUTOR_KEY=${env.DEMO_CONTRIBUTOR_KEY}\n`,
  );
  chmodSync(".env", 0o600);
  console.log("Actor keys saved to .env (0600)");
}
console.log(`requester   : ${requester.address}`);
console.log(`contributor : ${contributor.address}`);
console.log(`contract    : ${CONTRACT}`);
console.log();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function txLink(hash) {
  return `${EXPLORER}/tx/${hash}`;
}

// Studio Next's RPC is capacity-limited ("Server busy: all 8 execution
// slots occupied", code -32006, retry_after_seconds). Retry transient
// failures with backoff instead of dying on them.
async function withRetry(fn, label, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const busy = String(e?.message ?? e).includes("Server busy") ||
        String(e?.details ?? "").includes("Server busy");
      if (!busy || i === attempts - 1) throw e;
      const wait = 3000 * (i + 1);
      console.log(`  [retry ${label}: server busy, waiting ${wait / 1000}s]`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function fmtGen(wei) {
  return (Number(wei) / 1e18).toFixed(4) + " GEN";
}

async function write(method, account, args, value = 0n) {
  // Per-call fee estimation: Studio Next rejects txs whose fee
  // distribution is the bare default (FeeValueMustBeNonZero).
  const fees = await withRetry(
    () =>
      client.estimateTransactionFeesForWrite({
        account,
        address: CONTRACT,
        functionName: method,
        args,
        value,
      }),
    `estimate ${method}`,
  );
  const res = await client.writeContract({
    account,
    address: CONTRACT,
    functionName: method,
    args,
    value,
    fees,
  });
  const hash = res?.hash ?? res?.transactionHash ?? res;
  const decided = await client.waitForDecision({ hash, interval: 2000, retries: 120 });
  const status = decided?.statusName ?? decided?.lifecycle?.outcome ?? "unknown";
  console.log(`  ${method} -> ${hash}`);
  console.log(`  ${EXPLORER}/tx/${hash}  [${status}]`);
  if (String(status).toUpperCase() !== "ACCEPTED") {
    throw new Error(`${method} was not ACCEPTED (status: ${status})`);
  }
  return hash;
}

async function read(method, args = []) {
  return withRetry(
    () => client.readContract({ address: CONTRACT, functionName: method, args }),
    `read ${method}`,
  );
}

/* ------------------------------------------------------------------ */
/* Deals                                                               */
/* ------------------------------------------------------------------ */

const CRITERIA = "The photo must clearly show the Eiffel Tower illuminated at night";

const DEALS = {
  A: {
    id: "eiffel-night",
    description: "Pay 1 GEN for a photo that clearly shows the Eiffel Tower illuminated at night.",
    photoUrl: "https://commons.wikimedia.org/wiki/File:Eiffel_Tower_at_night.jpg",
    photoDescription: "Night photograph of the Eiffel Tower in Paris, fully illuminated against a dark sky.",
    expected: "released",
  },
  B: {
    id: "eiffel-night-2",
    description: "Pay 1 GEN for a photo that clearly shows the Eiffel Tower illuminated at night.",
    photoUrl: "https://commons.wikimedia.org/wiki/File:Colosseum_in_Rome,_Italy_-_April_2007.jpg",
    photoDescription: "Daytime photograph of the Colosseum in Rome, Italy.",
    expected: "refunded",
  },
};

async function runDeal(deal) {
  console.log(`=== Deal ${deal.id} (expect: ${deal.expected}) ===`);
  const balBefore = {
    requester: await withRetry(() => client.getBalance({ address: requester.address }), "balance requester"),
    contributor: await withRetry(() => client.getBalance({ address: contributor.address }), "balance contributor"),
    contract: await read("get_balance"),
  };
  console.log(`  balances before: requester ${fmtGen(balBefore.requester)}, contributor ${fmtGen(balBefore.contributor)}, contract ${fmtGen(balBefore.contract)}`);

  const txs = {};
  // Resumable: if a previous run already created/submitted this task,
  // pick up from the current on-chain state instead of failing.
  let existing = null;
  try {
    existing = await read("get_task", [deal.id]);
  } catch {
    existing = null;
  }
  const exists = existing && existing.id === deal.id;
  if (!exists) {
    txs.create = await write("create_task", requester, [deal.id, deal.description, CRITERIA], ONE_GEN);
  } else {
    console.log(`  task ${deal.id} already exists on-chain (status=${existing.status}), resuming`);
  }
  const current = exists ? existing : await read("get_task", [deal.id]);
  if (current.status === "open") {
    txs.submit = await write("submit_photo", contributor, [deal.id, deal.photoUrl, deal.photoDescription]);
  }
  const afterSubmit = txs.submit || txs.create ? await read("get_task", [deal.id]) : current;
  if (afterSubmit.status === "submitted") {
    txs.judge = await write("judge", requester, [deal.id]);
    // EOA payouts via emit_transfer settle when the judge tx FINALIZES,
    // not when it is decided — wait for finalization before reading balances.
    await client.waitForFinalization({ hash: txs.judge, interval: 2000, retries: 180 });
    console.log(`  judge tx finalized`);
    // Balance reads can lag finalization by a few seconds on Studio.
    await new Promise((r) => setTimeout(r, 8000));
  }

  const task = await read("get_task", [deal.id]);
  const status = task.status;
  const match = task.match;
  const reasoning = task.reasoning;
  console.log(`  VERDICT: status=${status} match=${match}`);
  console.log(`  reasoning: ${reasoning}`);
  const balAfter = {
    requester: await withRetry(() => client.getBalance({ address: requester.address }), "balance requester"),
    contributor: await withRetry(() => client.getBalance({ address: contributor.address }), "balance contributor"),
    contract: await read("get_balance"),
  };
  console.log(`  balances after : requester ${fmtGen(balAfter.requester)}, contributor ${fmtGen(balAfter.contributor)}, contract ${fmtGen(balAfter.contract)}`);
  console.log(`  claimable requester: ${fmtGen(await read("get_claimable", [requester.address]))}, contributor: ${fmtGen(await read("get_claimable", [contributor.address]))}`);
  const ok = status === deal.expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}: expected ${deal.expected}, got ${status}`);
  console.log();
  return { deal: deal.id, expected: deal.expected, status, match, reasoning, txs, ok };
}

const which = (process.argv[2] || "AB").toUpperCase();
const results = [];
for (const key of ["A", "B"]) {
  if (which.includes(key)) results.push(await runDeal(DEALS[key]));
}

console.log("=== Summary ===");
for (const r of results) {
  console.log(`Deal ${r.deal}: ${r.status} (expected ${r.expected}) — ${r.ok ? "PASS" : "FAIL"}`);
  for (const [step, hash] of Object.entries(r.txs)) {
    if (hash) console.log(`  ${step}: ${txLink(hash)}`);
  }
}
if (results.some((r) => !r.ok)) process.exit(2);
