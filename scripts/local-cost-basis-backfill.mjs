#!/usr/bin/env node
// Cost basis backfill v3 — uses searchMintedMoments (paginated, 100/page)
// Runs locally. Calls nbatopshot.com/marketplace/graphql directly.
//
// Usage: node scripts/local-cost-basis-backfill.mjs
//        node scripts/local-cost-basis-backfill.mjs 0xOTHER_WALLET

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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────
// Uses the marketplace graphql endpoint (Cloudflare-protected but works from local machine)
const TS_GQL = "https://nbatopshot.com/marketplace/graphql";
const DAPPER_ID = "google-oauth2|108942267116026679105";  // Trevor's Dapper ID
const WALLET = process.argv[2] || "0xbd94cade097e50ac";
const PAGE_SIZE = 100;
const DELAY_MS = 1500;  // 1.5s between pages to be safe

// ── GQL Query ─────────────────────────────────────────────────────────────────
const SEARCH_MINTED_MOMENTS = `
  query SearchMintedMoments($sortBy: MintedMomentSortType!, $byOwnerDapperID: [String!], $cursor: String!, $limit: Int!) {
    searchMintedMoments(input: {
      sortBy: $sortBy
      filters: {
        byOwnerDapperID: $byOwnerDapperID
      }
      searchInput: {
        pagination: {
          cursor: $cursor
          direction: RIGHT
          limit: $limit
        }
      }
    }) {
      data {
        searchSummary {
          pagination {
            rightCursor
            __typename
          }
          data {
            size
            data {
              ... on MintedMoment {
                flowId
                flowSerialNumber
                lastPurchasePrice
                acquiredAt
                price
                forSale
                isLocked
                tier
                parallelID
                topshotScore {
                  score
                  derivedVia
                  averageSalePrice
                }
                play {
                  id
                  stats {
                    playerName
                    teamAtMoment
                    jerseyNumber
                    playCategory
                    dateOfMoment
                  }
                }
                set {
                  id
                  flowName
                  flowSeriesNumber
                }
                setPlay {
                  circulationCount
                  flowRetired
                }
                edition {
                  marketplaceInfo {
                    averageSaleData {
                      averagePrice
                    }
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

// ── Fetch one page ────────────────────────────────────────────────────────────
async function fetchPage(cursor) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(TS_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Origin": "https://nbatopshot.com",
        "Referer": "https://nbatopshot.com/",
      },
      body: JSON.stringify({
        operationName: "SearchMintedMoments",
        query: SEARCH_MINTED_MOMENTS,
        variables: {
          sortBy: "ACQUIRED_AT_DESC",
          byOwnerDapperID: [DAPPER_ID],
          cursor: cursor,
          limit: PAGE_SIZE,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.status === 403 || res.status === 429) {
      return { error: `cloudflare_${res.status}`, data: null, nextCursor: null, totalCount: 0 };
    }

    if (!res.ok) {
      return { error: `http_${res.status}`, data: null, nextCursor: null, totalCount: 0 };
    }

    const json = await res.json();
    if (json.errors) {
      console.error("\nGQL errors:", JSON.stringify(json.errors).slice(0, 200));
      return { error: "gql_error", data: null, nextCursor: null, totalCount: 0 };
    }

    const summary = json?.data?.searchMintedMoments?.data?.searchSummary;
    const moments = summary?.data?.data ?? [];
    const nextCursor = summary?.pagination?.rightCursor ?? null;
    const totalCount = summary?.totalCount ?? 0;

    return { error: null, data: moments, nextCursor, totalCount };
  } catch (err) {
    clearTimeout(timeout);
    return { error: "network_error", data: null, nextCursor: null, totalCount: 0 };
  }
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function supabaseInsert(rows) {
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

async function getExistingCount() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/moment_acquisitions?wallet=eq.${encodeURIComponent(WALLET)}&select=nft_id`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
    }
  );
  const range = res.headers.get("content-range");
  const match = range?.match(/\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Cost Basis Backfill v3 (searchMintedMoments) ===");
  console.log(`Wallet: ${WALLET}`);
  console.log(`Dapper ID: ${DAPPER_ID}`);
  console.log(`Endpoint: ${TS_GQL}`);
  console.log("");

  const existingCount = await getExistingCount();
  console.log(`Existing acquisitions: ${existingCount}`);
  console.log("");

  let cursor = "";
  let page = 0;
  let totalProcessed = 0;
  let totalInserted = 0;
  let totalNoPrice = 0;
  let totalWithPrice = 0;
  let totalCount = 0;
  const startTime = Date.now();

  while (true) {
    page++;
    const result = await fetchPage(cursor);

    if (result.error) {
      console.error(`\nPage ${page} error: ${result.error}`);
      if (result.error.startsWith("cloudflare")) {
        console.log("Cloudflare blocked — waiting 30s then retrying...");
        await new Promise(r => setTimeout(r, 30000));
        continue; // retry same page
      }
      break;
    }

    if (!result.data || result.data.length === 0) {
      console.log(`\nPage ${page}: no more data`);
      break;
    }

    if (page === 1) {
      totalCount = result.totalCount;
      console.log(`Total moments in collection: ${totalCount}`);
      console.log(`Pages to process: ${Math.ceil(totalCount / PAGE_SIZE)}`);
      console.log("");
    }

    // Extract cost basis data from this page
    const acquisitionRows = [];

    for (const moment of result.data) {
      totalProcessed++;

      const flowId = moment.flowId;
      if (!flowId) continue;

      const lastPurchasePrice = moment.lastPurchasePrice
        ? parseFloat(moment.lastPurchasePrice)
        : null;

      if (!lastPurchasePrice || lastPurchasePrice <= 0) {
        totalNoPrice++;
        continue;
      }

      totalWithPrice++;

      // Get the average sale price at acquisition time (for fmv_at_acquisition)
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
        transaction_hash: "smm:" + flowId,  // searchMintedMoments source
        source: "search_minted_moments",
      });
    }

    // Write to Supabase
    if (acquisitionRows.length > 0) {
      await supabaseInsert(acquisitionRows);
      totalInserted += acquisitionRows.length;
    }

    // Progress
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const pagesTotal = Math.ceil(totalCount / PAGE_SIZE);
    const etaSec = Math.round((pagesTotal - page) * (DELAY_MS / 1000 + 1));
    const etaMin = Math.floor(etaSec / 60);
    console.log(
      `  Page ${page}/${pagesTotal} | ${totalProcessed} moments | ` +
      `${totalInserted} with price | ${totalNoPrice} pack/gift | ` +
      `${elapsed}s elapsed | ETA: ${etaMin}m${etaSec % 60}s`
    );

    // Next page
    if (!result.nextCursor) {
      console.log("\nNo more pages (cursor exhausted)");
      break;
    }
    cursor = result.nextCursor;

    // Delay between pages
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("");
  console.log("=== COMPLETE ===");
  console.log(`  Total moments:     ${totalProcessed}`);
  console.log(`  With purchase price: ${totalInserted} (marketplace buys)`);
  console.log(`  No price (pack/gift): ${totalNoPrice}`);
  console.log(`  Time:              ${elapsed}s`);
  console.log(`  Previous acquisitions: ${existingCount}`);
  console.log(`  New acquisitions:  ${totalInserted}`);
  console.log("");
  console.log("Reload your collection page to see Paid / P&L columns populated.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
