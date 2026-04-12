#!/usr/bin/env node
// Purchase price backfill — re-runs searchMintedMoments to populate
// moment_acquisitions.buy_price and wallet_moments_cache.acquired_at for
// moments that are not yet recorded.
//
// Differs from scripts/local-cost-basis-backfill.mjs in three ways:
//   1. Reads TOPSHOT_SESSION_COOKIE + TOPSHOT_ID_TOKEN from .env.local (no
//      hard-coded PASTE_... placeholders — rotate them via browser DevTools)
//   2. Resume-safe: pre-loads existing moment_acquisitions.nft_id into a Set
//      and skips moments already recorded, so re-runs are cheap
//   3. Also upserts wallet_moments_cache.acquired_at from the GQL response
//      (both pack mints and marketplace buys), since only ~27% of cache rows
//      currently carry an acquired_at timestamp
//
// Requires a fresh Top Shot session. In browser DevTools → Network → find a
// SearchMintedMoments request → right-click → Copy as cURL. Grab:
//   - The Cookie header (only cf_clearance, sid, ts:s0-s4 are load-bearing)
//   - The x-id-token header (a JWT that expires ~30 minutes after login)
// Drop them into .env.local as TOPSHOT_SESSION_COOKIE and TOPSHOT_ID_TOKEN.
//
// Usage: node scripts/backfill-purchase-prices.mjs
//        node scripts/backfill-purchase-prices.mjs 0xOTHER_WALLET

import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";

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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    console.error("Could not read .env.local — run from project root");
    process.exit(1);
  }
}
loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COOKIE = process.env.TOPSHOT_SESSION_COOKIE;
const X_ID_TOKEN = process.env.TOPSHOT_ID_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
if (!COOKIE || !X_ID_TOKEN) {
  console.error("Missing TOPSHOT_SESSION_COOKIE or TOPSHOT_ID_TOKEN in .env.local");
  console.error("Grab a fresh cookie + x-id-token from nbatopshot.com DevTools (see header comment)");
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────
const TS_GQL = "https://nbatopshot.com/marketplace/graphql";
const DAPPER_ID = "google-oauth2|108942267116026679105";  // Trevor's Dapper ID
const WALLET = process.argv[2] || "0xbd94cade097e50ac";
const NBA_TOP_SHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const PAGE_SIZE = 100;
const DELAY_MS = 1000; // 1 req/sec per the task spec

// ── GQL Query ─────────────────────────────────────────────────────────────────
const SEARCH_MINTED_MOMENTS = `
  query SearchMintedMoments($sortBy: MintedMomentSortType!, $byOwnerDapperID: [String!], $cursor: Cursor!, $limit: Int!) {
    searchMintedMoments(input: {
      sortBy: $sortBy
      filters: { byOwnerDapperID: $byOwnerDapperID }
      searchInput: {
        pagination: { cursor: $cursor, direction: RIGHT, limit: $limit }
      }
    }) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            size
            data {
              ... on MintedMoment {
                flowId
                flowSerialNumber
                lastPurchasePrice
                acquiredAt
                forSale
                play { id stats { playerName teamAtMoment } }
                set { id flowSeriesNumber }
                edition {
                  id
                  marketplaceInfo {
                    averageSaleData { averagePrice }
                  }
                }
              }
            }
          }
          totalCount
        }
      }
    }
  }
`;

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// ── Fetch one page (via curl.exe — Cloudflare blocks Node fetch) ─────────────
async function fetchPage(cursor) {
  const body = JSON.stringify({
    operationName: "SearchMintedMoments",
    query: SEARCH_MINTED_MOMENTS,
    variables: {
      sortBy: "ACQUIRED_AT_DESC",
      byOwnerDapperID: [DAPPER_ID],
      cursor,
      limit: PAGE_SIZE,
    },
  });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bodyFile = resolve(tmpdir(), `rpc-pp-body-${stamp}.json`);
  const configFile = resolve(tmpdir(), `rpc-pp-cfg-${stamp}.txt`);
  const outFile = resolve(tmpdir(), `rpc-pp-out-${stamp}.txt`);
  writeFileSync(bodyFile, body, "utf-8");

  const configLines = [
    "-s",
    "-X POST",
    `-H "Content-Type: application/json"`,
    `-H "User-Agent: ${USER_AGENT}"`,
    `-H "Origin: https://nbatopshot.com"`,
    `-H "Referer: https://nbatopshot.com/"`,
    `-H "Cookie: ${COOKIE}"`,
    `-H "x-id-token: ${X_ID_TOKEN}"`,
    `--data @${bodyFile}`,
    "",
  ];
  writeFileSync(configFile, configLines.join("\n"), "utf-8");

  try {
    let curlStatus = 0;
    const curlCmd = `curl.exe --config "${configFile}" -o "${outFile}" "${TS_GQL}?SearchMintedMoments"`;

    try {
      execSync(curlCmd, { maxBuffer: 64 * 1024 * 1024, timeout: 30000, windowsHide: true, encoding: "utf-8" });
    } catch (err) {
      curlStatus = err?.status ?? -1;
      const stderrStr = typeof err?.stderr === "string" ? err.stderr : (err?.stderr ? err.stderr.toString("utf-8") : "");
      console.log(`[debug] curl exit ${curlStatus}: ${stderrStr ? stderrStr.slice(0, 200) : "(no stderr)"}`);
    }

    let stdout = "";
    try {
      stdout = readFileSync(outFile, "utf-8");
    } catch (readErr) {
      return { error: "curl_error", data: null, nextCursor: null, totalCount: 0 };
    }

    if (!stdout || !stdout.trim()) {
      return { error: "empty_response", data: null, nextCursor: null, totalCount: 0 };
    }

    let json;
    try {
      json = JSON.parse(stdout);
    } catch {
      const snippet = stdout.slice(0, 200);
      if (snippet.includes("Cloudflare") || snippet.includes("cf-") || snippet.includes("Just a moment")) {
        return { error: "cloudflare_block", data: null, nextCursor: null, totalCount: 0 };
      }
      console.error("\nParse error. First 200 chars:", snippet);
      return { error: "parse_error", data: null, nextCursor: null, totalCount: 0 };
    }

    if (json.errors) {
      const msg = JSON.stringify(json.errors).slice(0, 300);
      console.error("\nGQL errors:", msg);
      if (msg.toLowerCase().includes("unauthorized") || msg.toLowerCase().includes("expired")) {
        return { error: "auth_expired", data: null, nextCursor: null, totalCount: 0 };
      }
      return { error: "gql_error", data: null, nextCursor: null, totalCount: 0 };
    }

    const summary = json?.data?.searchMintedMoments?.data?.searchSummary;
    const moments = summary?.data?.data ?? [];
    const nextCursor = summary?.pagination?.rightCursor ?? null;
    const totalCount = summary?.totalCount ?? 0;
    return { error: null, data: moments, nextCursor, totalCount };
  } finally {
    try { unlinkSync(bodyFile); } catch {}
    try { unlinkSync(configFile); } catch {}
    try { unlinkSync(outFile); } catch {}
  }
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function loadExistingAcquisitions() {
  // Paginate to bypass the default PostgREST 1000-row cap.
  const seen = new Set();
  let from = 0;
  const step = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/moment_acquisitions?wallet=eq.${encodeURIComponent(WALLET)}&select=nft_id`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Range: `${from}-${from + step - 1}`,
          "Range-Unit": "items",
        },
      }
    );
    if (!res.ok) {
      console.error(`Failed to load existing acquisitions: ${res.status}`);
      return seen;
    }
    const rows = await res.json();
    for (const row of rows) seen.add(row.nft_id);
    if (rows.length < step) break;
    from += step;
  }
  return seen;
}

async function supabaseInsertAcquisitions(rows) {
  if (rows.length === 0) return true;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/moment_acquisitions`, {
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
      console.error(`\nSupabase insert error: ${res.status} ${text.slice(0, 200)}`);
      return false;
    }
  }
  return true;
}

async function supabaseUpdateCacheAcquiredAt(updates) {
  // Updates wallet_moments_cache.acquired_at for a batch of (moment_id, acquired_at) pairs.
  // PATCH per row because PostgREST has no bulk-update-by-id primitive short of
  // upsert on a composite key. Fire in parallel — trivial cost, never blocks.
  if (updates.length === 0) return;
  const promises = updates.map(({ moment_id, acquired_at }) =>
    fetch(
      `${SUPABASE_URL}/rest/v1/wallet_moments_cache?wallet_address=eq.${encodeURIComponent(WALLET)}&moment_id=eq.${encodeURIComponent(moment_id)}&collection_id=eq.${NBA_TOP_SHOT_COLLECTION_ID}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ acquired_at }),
      }
    ).catch(() => null)
  );
  await Promise.all(promises);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Purchase Price Backfill (searchMintedMoments, resume-safe) ===");
  console.log(`Wallet:    ${WALLET}`);
  console.log(`Dapper ID: ${DAPPER_ID}`);
  console.log(`Endpoint:  ${TS_GQL}`);
  console.log("");

  console.log("Loading existing acquisitions...");
  const existing = await loadExistingAcquisitions();
  console.log(`  ${existing.size} moments already have buy_price recorded — will be skipped`);
  console.log("");

  let cursor = "";
  let page = 0;
  let totalSeen = 0;
  let totalSkipped = 0;
  let totalInserted = 0;
  let totalNoPrice = 0;
  let totalCacheUpdates = 0;
  let totalCount = 0;
  const startTime = Date.now();

  while (true) {
    page++;
    const result = await fetchPage(cursor);

    if (result.error) {
      if (result.error === "cloudflare_block") {
        console.log("Cloudflare blocked — waiting 30s then retrying...");
        await new Promise((r) => setTimeout(r, 30000));
        continue;
      }
      if (result.error === "auth_expired") {
        console.error("Session expired — grab a fresh cookie + x-id-token from DevTools and re-run");
        break;
      }
      console.error(`Page ${page} error: ${result.error} — aborting`);
      break;
    }

    if (!result.data || result.data.length === 0) {
      console.log("\nNo more moments (cursor exhausted)");
      break;
    }

    if (page === 1) {
      totalCount = result.totalCount;
      console.log(`Total moments in collection: ${totalCount}`);
      console.log(`Pages to process: ${Math.ceil(totalCount / PAGE_SIZE)}\n`);
    }

    const acquisitionRows = [];
    const cacheUpdates = [];

    for (const moment of result.data) {
      totalSeen++;
      const flowId = moment.flowId;
      if (!flowId) continue;

      // Always capture acquired_at for the cache, even when already recorded.
      if (moment.acquiredAt) {
        cacheUpdates.push({ moment_id: flowId, acquired_at: moment.acquiredAt });
      }

      // Resume-safe: skip the insert if we've already recorded this nft_id.
      if (existing.has(flowId)) {
        totalSkipped++;
        continue;
      }

      const lastPurchasePrice = moment.lastPurchasePrice ? parseFloat(moment.lastPurchasePrice) : null;
      if (!lastPurchasePrice || lastPurchasePrice <= 0) {
        totalNoPrice++;
        continue;
      }

      const avgSalePrice = moment.edition?.marketplaceInfo?.averageSaleData?.averagePrice
        ? parseFloat(moment.edition.marketplaceInfo.averageSaleData.averagePrice)
        : null;

      acquisitionRows.push({
        nft_id: flowId,
        wallet: WALLET,
        buy_price: lastPurchasePrice,
        acquired_date: moment.acquiredAt || new Date().toISOString(),
        acquired_type: 1,
        fmv_at_acquisition: avgSalePrice,
        seller_address: null,
        transaction_hash: "smm:" + flowId,
        source: "purchase_price_backfill",
        collection_id: NBA_TOP_SHOT_COLLECTION_ID,
      });
      existing.add(flowId); // prevent duplicate inserts within a single run
    }

    if (acquisitionRows.length > 0) {
      const ok = await supabaseInsertAcquisitions(acquisitionRows);
      if (ok) totalInserted += acquisitionRows.length;
    }

    if (cacheUpdates.length > 0) {
      await supabaseUpdateCacheAcquiredAt(cacheUpdates);
      totalCacheUpdates += cacheUpdates.length;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const pagesTotal = Math.ceil(totalCount / PAGE_SIZE);
    const etaSec = Math.round((pagesTotal - page) * (DELAY_MS / 1000 + 1));
    const etaMin = Math.floor(etaSec / 60);
    console.log(
      `  Page ${page}/${pagesTotal} | seen ${totalSeen} | ` +
        `new ${totalInserted} | skipped ${totalSkipped} | ` +
        `pack/gift ${totalNoPrice} | cache ${totalCacheUpdates} | ` +
        `${elapsed}s | ETA ${etaMin}m${etaSec % 60}s`
    );

    if (!result.nextCursor) {
      console.log("\nNo more pages (cursor exhausted)");
      break;
    }
    cursor = result.nextCursor;
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n=== COMPLETE ===");
  console.log(`  Moments seen:          ${totalSeen}`);
  console.log(`  New acquisitions:      ${totalInserted}`);
  console.log(`  Already recorded:      ${totalSkipped}`);
  console.log(`  No price (pack/gift):  ${totalNoPrice}`);
  console.log(`  Cache acquired_at:     ${totalCacheUpdates}`);
  console.log(`  Time:                  ${elapsed}s`);
  console.log("\nReload the collection page to see Paid / P&L columns populated.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
