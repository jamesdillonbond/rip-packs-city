#!/usr/bin/env node
// Local cost basis backfill — runs on your machine, not Vercel.
// Calls Top Shot GQL directly (no Cloudflare block from residential IP).
// Writes to Supabase via REST API.
//
// Usage: node scripts/local-cost-basis-backfill.mjs [wallet]
//
// Reads from .env.local:
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { readFileSync } from "fs";
import { resolve } from "path";

// ── Load .env.local ───────────────────────────────────────────────────────────
function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), ".env.local");
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    console.error("Could not read .env.local — make sure you run from the project root");
    process.exit(1);
  }
}

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WALLET = process.argv[2] || "0xbd94cade097e50ac";
const TS_GQL = "https://public-api.nbatopshot.com/graphql";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────
const PARALLEL = 5;
const BATCH_DELAY_MS = 300;
const GQL_TIMEOUT_MS = 10000;
const CHUNK_SIZE = 100; // Write to Supabase in chunks

// ── GQL Query ─────────────────────────────────────────────────────────────────
const GET_MINTED_MOMENT = `
  query GetMintedMoment($momentId: ID!) {
    getMintedMoment(momentId: $momentId) {
      data {
        flowId
        flowSerialNumber
        lastPurchasePrice
        createdAt
        play { stats { playerName } }
        set { flowName }
      }
    }
  }
`;

// ── Fetch owned IDs via Flow Access API ───────────────────────────────────────
async function fetchOwnedIds(wallet) {
  console.log(`Fetching owned IDs for ${wallet} via Flow Access API...`);

  // Use Flow's REST API to execute a Cadence script
  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all) fun main(addr: Address): [UInt64] {
      let acct = getAccount(addr)
      let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
        ?? panic("no collection")
      return col.getIDs()
    }
  `;

  const res = await fetch("https://rest-mainnet.onflow.org/v1/scripts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script: Buffer.from(cadence).toString("base64"),
      arguments: [
        Buffer.from(JSON.stringify({ type: "Address", value: wallet })).toString("base64"),
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flow script failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  // Response is base64-encoded JSON-CDC
  const decoded = JSON.parse(Buffer.from(json, "base64").toString("utf-8"));
  // CDC array of UInt64 → array of strings
  const ids = decoded.value.map((v) => v.value);
  console.log(`Found ${ids.length} owned moments`);
  return ids;
}

// ── Fetch moment data from TS GQL ─────────────────────────────────────────────
async function fetchMomentData(flowId) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GQL_TIMEOUT_MS);

    const res = await fetch(TS_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: JSON.stringify({
        query: GET_MINTED_MOMENT,
        variables: { momentId: flowId },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data?.getMintedMoment?.data;
    if (!data) return null;

    return {
      lastPurchasePrice: data.lastPurchasePrice != null ? Number(data.lastPurchasePrice) : null,
      createdAt: data.createdAt ?? null,
      playerName: data.play?.stats?.playerName ?? null,
      setName: data.set?.flowName ?? null,
    };
  } catch {
    return null;
  }
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function supabaseSelect(table, params) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

async function supabaseInsert(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    if (!text.includes("duplicate") && !text.includes("23505")) {
      console.error(`Supabase insert error: ${res.status} ${text}`);
      return false;
    }
  }
  return true;
}

// ── Get existing acquisitions ─────────────────────────────────────────────────
async function getExistingNftIds(wallet) {
  console.log("Checking existing acquisitions...");
  // Use RPC to bypass 1000-row PostgREST cap
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_wallet_cost_basis`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_wallet: wallet }),
  });
  const data = await res.json();
  const existing = new Set();
  if (Array.isArray(data)) {
    for (const row of data) existing.add(row.nft_id);
  }
  console.log(`Already have ${existing.size} acquisitions for this wallet`);
  return existing;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Cost Basis GQL Backfill (Local) ===");
  console.log(`Wallet: ${WALLET}`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log("");

  // 1. Get owned IDs
  const allIds = await fetchOwnedIds(WALLET);

  // 2. Get already-backfilled IDs
  const existing = await getExistingNftIds(WALLET);

  // 3. Filter to unprocessed
  const toProcess = allIds.filter((id) => !existing.has(id));
  console.log(`\nTo process: ${toProcess.length} (skipping ${existing.size} already done)\n`);

  if (toProcess.length === 0) {
    console.log("Nothing to do!");
    return;
  }

  // 4. Process in batches
  let totalInserted = 0;
  let totalNoPrice = 0;
  let totalErrors = 0;
  const pendingRows = [];
  const startTime = Date.now();

  for (let i = 0; i < toProcess.length; i += PARALLEL) {
    const batch = toProcess.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(batch.map(fetchMomentData));

    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      const flowId = batch[j];

      if (result.status !== "fulfilled" || !result.value) {
        totalErrors++;
        continue;
      }

      const data = result.value;
      if (!data.lastPurchasePrice || data.lastPurchasePrice <= 0) {
        totalNoPrice++;
        continue;
      }

      pendingRows.push({
        nft_id: flowId,
        wallet: WALLET,
        buy_price: data.lastPurchasePrice,
        acquired_date: data.createdAt || new Date().toISOString(),
        acquired_type: 1,
        fmv_at_acquisition: null,
        seller_address: null,
        transaction_hash: "gql:" + flowId,
        source: "gql_backfill",
      });
    }

    // Write to Supabase in chunks
    if (pendingRows.length >= CHUNK_SIZE) {
      const toWrite = pendingRows.splice(0, CHUNK_SIZE);
      await supabaseInsert("moment_acquisitions", toWrite);
      totalInserted += toWrite.length;
    }

    // Progress
    const processed = Math.min(i + PARALLEL, toProcess.length);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (processed / (Number(elapsed) || 1)).toFixed(1);
    const eta = ((toProcess.length - processed) / (Number(rate) || 1)).toFixed(0);
    process.stdout.write(
      `\r  ${processed}/${toProcess.length} | inserted: ${totalInserted + pendingRows.length} | noPrice: ${totalNoPrice} | errors: ${totalErrors} | ${rate}/s | ETA: ${eta}s  `
    );

    // Delay between batches
    if (i + PARALLEL < toProcess.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Flush remaining
  if (pendingRows.length > 0) {
    await supabaseInsert("moment_acquisitions", pendingRows);
    totalInserted += pendingRows.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n");
  console.log("=== COMPLETE ===");
  console.log(`  Processed:  ${toProcess.length}`);
  console.log(`  Inserted:   ${totalInserted}`);
  console.log(`  No price:   ${totalNoPrice} (pack pulls / gifts)`);
  console.log(`  GQL errors: ${totalErrors}`);
  console.log(`  Time:       ${elapsed}s`);
  console.log("");
  console.log("Verify by reloading your collection page, or run:");
  console.log(`  curl "${SUPABASE_URL}/rest/v1/rpc/get_wallet_cost_basis" \\`);
  console.log(`    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"p_wallet":"${WALLET}"}'`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
