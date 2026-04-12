/**
 * scripts/cryptoslam-scrape.ts
 *
 * Historical NBA Top Shot sales backfill for 2024–2025.
 *
 * Strategy:
 *   1. Try Flowty sales history endpoint (POST api2.flowty.io/sales/...)
 *   2. Fall back to Top Shot public GQL (searchMarketplaceTransactions)
 *      paginating via cursor, filtering dates client-side.
 *
 * The Top Shot GQL API does NOT support date range filters — it only
 * supports cursor-based pagination sorted by UPDATED_AT_DESC. We page
 * through all results and filter to 2024–2025 in JavaScript.
 *
 * Stop conditions:
 *   - 3 consecutive pages where ALL results are before 2024 → done
 *   - No more pages (rightCursor is null)
 *   - Hard cap of 5000 pages
 *
 * Env vars:
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY               — Supabase admin key
 *
 * Usage:
 *   npx tsx scripts/cryptoslam-scrape.ts
 */

import { createClient } from "@supabase/supabase-js";

// ── Config ──────────────────────────────────────────────────────────────────

const TOPSHOT_GQL = "https://public-api.nbatopshot.com/graphql";
const FLOWTY_SALES = "https://api2.flowty.io/sales/0x0b2a3299cc857e29/TopShot";
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.flowty.io",
  Referer: "https://www.flowty.io/",
};

const GQL_PAGE_SIZE = 100;
const INSERT_BATCH = 50;
const DELAY_MS = 200;
const MAX_RETRIES = 5;
const MAX_PAGES = 5000;

const DATE_START = "2024-01-01T00:00:00Z";
const DATE_END = "2025-12-31T23:59:59Z";

// ── Supabase client ─────────────────────────────────────────────────────────

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── GQL query ───────────────────────────────────────────────────────────────

const SEARCH_TRANSACTIONS_QUERY = `
  query BackfillSales($input: SearchMarketplaceTransactionsInput!) {
    searchMarketplaceTransactions(input: $input) {
      data {
        searchSummary {
          pagination {
            rightCursor
          }
          data {
            ... on MarketplaceTransactions {
              size
              data {
                ... on MarketplaceTransaction {
                  id
                  price
                  updatedAt
                  txHash
                  moment {
                    id
                    flowId
                    flowSerialNumber
                    tier
                    set {
                      id
                      flowName
                      flowSeriesNumber
                    }
                    setPlay {
                      ID
                      flowRetired
                    }
                    parallelSetPlay {
                      setID
                      playID
                    }
                    play {
                      id
                      stats {
                        playerName
                        playCategory
                        dateOfMoment
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ── Types ───────────────────────────────────────────────────────────────────

interface SaleTransaction {
  id: string;
  price: number | null;
  updatedAt: string | null;
  txHash: string | null;
  moment: {
    id: string;
    flowId: string | null;
    flowSerialNumber: string | null;
    tier: string | null;
    set: { id: string; flowName: string | null; flowSeriesNumber: number | null } | null;
    setPlay: { ID: string; flowRetired: boolean | null } | null;
    parallelSetPlay: { setID: string | null; playID: string | null } | null;
    play: {
      id: string;
      stats: { playerName: string | null; playCategory: string | null; dateOfMoment: string | null } | null;
    } | null;
  } | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildEditionKey(tx: SaleTransaction): string | null {
  const moment = tx.moment;
  if (!moment) return null;
  const psp = moment.parallelSetPlay;
  const setId = psp?.setID ?? moment.set?.id;
  const playId = psp?.playID ?? moment.play?.id;
  if (!setId || !playId) return null;
  return `${setId}:${playId}`;
}

function isInDateRange(dateStr: string): boolean {
  return dateStr >= DATE_START && dateStr <= DATE_END;
}

function isBeforeRange(dateStr: string): boolean {
  return dateStr < DATE_START;
}

// ── Edition lookup & upsert ─────────────────────────────────────────────────

let collectionId: string | null = null;

async function getCollectionId(): Promise<string> {
  if (collectionId) return collectionId;
  const { data } = await supabase
    .from("collections")
    .select("id")
    .eq("slug", "nba_top_shot")
    .single();
  collectionId = data?.id ?? null;
  if (!collectionId) throw new Error("nba_top_shot collection not found");
  return collectionId;
}

async function ensureEdition(tx: SaleTransaction, colId: string): Promise<string | null> {
  const editionKey = buildEditionKey(tx);
  if (!editionKey) return null;

  const moment = tx.moment;
  const playerName = moment?.play?.stats?.playerName ?? "Unknown";
  const setName = moment?.set?.flowName ?? "Unknown Set";

  const { data, error } = await supabase
    .from("editions")
    .upsert(
      {
        external_id: editionKey,
        collection_id: colId,
        name: `${playerName} — ${setName}`,
        tier: (moment?.tier ?? "COMMON").toUpperCase(),
        series: moment?.set?.flowSeriesNumber ?? null,
        play_category: moment?.play?.stats?.playCategory ?? null,
        game_date: moment?.play?.stats?.dateOfMoment
          ? moment.play.stats.dateOfMoment.split("T")[0]
          : null,
      },
      { onConflict: "external_id,collection_id", ignoreDuplicates: false },
    )
    .select("id")
    .single();

  if (error) {
    const { data: existing } = await supabase
      .from("editions")
      .select("id")
      .eq("external_id", editionKey)
      .single();
    return existing?.id ?? null;
  }
  return data?.id ?? null;
}

// ── Flowty sales attempt ────────────────────────────────────────────────────

async function tryFlowty(): Promise<boolean> {
  console.log("Attempting Flowty sales endpoint...");
  try {
    const res = await fetch(FLOWTY_SALES, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify({ page: 1, pageSize: 5, startDate: "2024-01-01", endDate: "2024-01-31" }),
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`  Flowty status: ${res.status}`);
    const body = await res.text();
    console.log(`  Flowty raw response (first 2000 chars):`);
    console.log(body.slice(0, 2000));

    if (res.ok) {
      try {
        const json = JSON.parse(body);
        const records = Array.isArray(json) ? json : json?.data ?? json?.sales ?? json?.results ?? [];
        if (Array.isArray(records) && records.length > 0) {
          console.log(`  Found ${records.length} records — Flowty sales endpoint is live`);
          return true;
        }
      } catch {
        // not JSON
      }
    }
    console.log("  Flowty sales endpoint did not return usable data, falling back to GQL");
    return false;
  } catch (err) {
    console.log(`  Flowty error: ${err}`);
    return false;
  }
}

// ── GQL fetching (no date filters — cursor only) ───────────────────────────

async function fetchGqlPage(
  cursor: string | null,
): Promise<{ transactions: SaleTransaction[]; nextCursor: string | null }> {
  let delay = 1000;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(TOPSHOT_GQL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: SEARCH_TRANSACTIONS_QUERY,
          variables: {
            input: {
              sortBy: "UPDATED_AT_DESC",
              filters: {},
              searchInput: {
                pagination: {
                  cursor: cursor ?? "",
                  direction: "RIGHT",
                  limit: GQL_PAGE_SIZE,
                },
              },
            },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt === MAX_RETRIES) throw new Error(`GQL ${res.status} after ${MAX_RETRIES + 1} attempts`);
        console.warn(`  GQL HTTP ${res.status}, retrying in ${delay}ms`);
        await sleep(delay);
        delay *= 2;
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GQL ${res.status}: ${text.slice(0, 300)}`);
      }

      const json = await res.json();

      // Check for GQL errors
      if (json.errors) {
        console.error("  GQL errors:", JSON.stringify(json.errors).slice(0, 500));
      }

      const summary = json?.data?.searchMarketplaceTransactions?.data?.searchSummary;
      const nextCursorVal: string | null = summary?.pagination?.rightCursor ?? null;

      const transactions: SaleTransaction[] = [];
      const dataField = summary?.data;

      if (Array.isArray(dataField)) {
        for (const block of dataField) {
          if (Array.isArray(block?.data)) {
            transactions.push(...block.data);
          }
        }
      } else if (dataField && typeof dataField === "object" && Array.isArray(dataField.data)) {
        transactions.push(...dataField.data);
      }

      return { transactions, nextCursor: nextCursorVal };
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.warn(`  GQL error, retrying in ${delay}ms: ${err}`);
      await sleep(delay);
      delay *= 2;
    }
  }
  return { transactions: [], nextCursor: null };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Historical Sales Backfill — NBA Top Shot 2024–2025");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Date range: ${DATE_START} → ${DATE_END}`);
  console.log(`  Max pages:  ${MAX_PAGES}\n`);

  const colId = await getCollectionId();
  console.log(`Collection ID: ${colId}\n`);

  // ── Try Flowty first ──────────────────────────────────────────────────
  const flowtyWorks = await tryFlowty();

  if (flowtyWorks) {
    console.log("\nFlowty sales endpoint responded — but full pagination logic");
    console.log("requires inspecting the response shape above. Falling through");
    console.log("to GQL backfill which is the proven path.\n");
  }

  // ── GQL backfill — paginate all, filter client-side ───────────────────
  console.log("Starting GQL cursor-based backfill...\n");

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalEditionsMissing = 0;
  let totalTransactions = 0;
  let totalInRange = 0;
  const startTime = Date.now();
  let firstResponseLogged = false;

  let cursor: string | null = null;
  let consecutiveBeforeRange = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { transactions, nextCursor } = await fetchGqlPage(cursor);

    // Log raw first response
    if (!firstResponseLogged && transactions.length > 0) {
      console.log("First GQL response sample:");
      console.log(JSON.stringify(transactions[0], null, 2).slice(0, 1500));
      console.log("");
      firstResponseLogged = true;
    }

    if (transactions.length === 0) {
      console.log(`Page ${page}: empty response, stopping.`);
      break;
    }

    totalTransactions += transactions.length;

    // Check if all results on this page are before our date range
    const datedTxs = transactions.filter((tx) => tx.updatedAt);
    const allBeforeRange = datedTxs.length > 0 && datedTxs.every((tx) => isBeforeRange(tx.updatedAt!));

    if (allBeforeRange) {
      consecutiveBeforeRange++;
      if (consecutiveBeforeRange >= 3) {
        console.log(`Page ${page}: 3 consecutive pages before 2024, stopping.`);
        break;
      }
    } else {
      consecutiveBeforeRange = 0;
    }

    // Filter to only 2024–2025 transactions
    const inRange = transactions.filter(
      (tx) => tx.updatedAt && isInDateRange(tx.updatedAt) && tx.txHash && tx.price && tx.price > 0,
    );

    totalInRange += inRange.length;

    if (inRange.length > 0) {
      // Build sale rows
      const rows: object[] = [];
      for (const tx of inRange) {
        const editionId = await ensureEdition(tx, colId);
        if (!editionId) {
          totalEditionsMissing++;
          totalSkipped++;
          continue;
        }

        const nftId = tx.moment?.flowId ? String(tx.moment.flowId) : null;
        const serialNumber = tx.moment?.flowSerialNumber ? parseInt(tx.moment.flowSerialNumber, 10) : 0;

        // Write moment cache if we have flowId
        if (nftId && serialNumber) {
          await supabase
            .from("moments")
            .upsert(
              { nft_id: nftId, edition_id: editionId, collection_id: colId, serial_number: serialNumber },
              { onConflict: "nft_id", ignoreDuplicates: true },
            );
        }

        rows.push({
          edition_id: editionId,
          collection_id: colId,
          serial_number: serialNumber,
          nft_id: nftId,
          price_usd: tx.price,
          price_native: null,
          currency: "USD",
          marketplace: "topshot",
          transaction_hash: tx.txHash,
          sold_at: tx.updatedAt,
          seller_address: null,
          buyer_address: null,
        });
      }

      // Batch insert
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const batch = rows.slice(i, i + INSERT_BATCH);
        const { error, count } = await supabase.from("sales").insert(batch, { count: "exact" });
        if (error) {
          if (error.code === "23505" || error.message?.includes("duplicate")) {
            totalSkipped += batch.length;
          } else {
            console.error(`  Insert error: ${error.message}`);
            totalSkipped += batch.length;
          }
        } else {
          totalInserted += count ?? batch.length;
        }
      }
    }

    // Log progress every 100 pages
    if (page % 100 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const oldest = datedTxs.length > 0 ? datedTxs[datedTxs.length - 1].updatedAt : "?";
      console.log(
        `[Page ${page}] ` +
          `Total txns: ${totalTransactions.toLocaleString()} | ` +
          `In range: ${totalInRange.toLocaleString()} | ` +
          `Inserted: ${totalInserted.toLocaleString()} | ` +
          `Skipped: ${totalSkipped.toLocaleString()} | ` +
          `Oldest on page: ${oldest} | ` +
          `Elapsed: ${elapsed}min`,
      );
    }

    if (!nextCursor) {
      console.log(`Page ${page}: no more pages (cursor is null), stopping.`);
      break;
    }
    cursor = nextCursor;
    await sleep(DELAY_MS);
  }

  // Final summary
  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Backfill Complete");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Total transactions seen: ${totalTransactions.toLocaleString()}`);
  console.log(`  In date range:          ${totalInRange.toLocaleString()}`);
  console.log(`  Total inserted:         ${totalInserted.toLocaleString()}`);
  console.log(`  Total skipped/dupes:    ${totalSkipped.toLocaleString()}`);
  console.log(`  Editions missing:       ${totalEditionsMissing.toLocaleString()}`);
  console.log(`  Elapsed:                ${totalElapsed} min`);
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
