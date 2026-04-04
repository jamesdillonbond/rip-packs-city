/**
 * scripts/flow-backfill.ts
 *
 * Backfills historical NBA Top Shot sales from the Flow blockchain directly,
 * bypassing the Top Shot GQL API entirely. Queries on-chain events from the
 * Flow Access Node REST API and inserts matched sales into Supabase.
 *
 * Event types indexed:
 *   - A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted (primary)
 *   - A.c1e4f4f4c4257510.Market.MomentPurchased (legacy)
 *
 * Env vars:
 *   NEXT_PUBLIC_SUPABASE_URL  — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase admin key
 *   START_HEIGHT             — first block (default 73000000 ≈ Jan 1 2024)
 *   END_HEIGHT               — last block  (default 96000000 ≈ Jan 1 2026)
 *
 * Usage:
 *   npx ts-node --skip-project scripts/flow-backfill.ts
 */

import { createClient } from "@supabase/supabase-js";

// ── Config ──────────────────────────────────────────────────────────────────

const FLOW_REST = "https://rest-mainnet.onflow.org/v1";
const BATCH_SIZE = 250; // max blocks per event query
const DELAY_MS = 100; // ms between batch calls
const LOG_EVERY = 10_000; // log progress every N blocks
const INSERT_BATCH = 50; // rows per Supabase insert

const EVENT_STOREFRONT = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted";
const EVENT_MARKET = "A.c1e4f4f4c4257510.Market.MomentPurchased";

const DEFAULT_START = 73_000_000; // ~Jan 1 2024
const DEFAULT_END = 96_000_000; // ~Jan 1 2026

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

// ── Types ───────────────────────────────────────────────────────────────────

interface CadenceField {
  name: string;
  value: { type: string; value: unknown };
}

interface ParsedSale {
  nftId: string;
  price: number;
  seller: string | null;
  buyer: string | null;
  transactionId: string;
  blockTimestamp: string;
  marketplace: string;
}

interface ProgressRow {
  last_processed_height: number;
  total_events_found: number;
  total_inserted: number;
  total_skipped: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch with exponential backoff on 429 / 5xx.
 */
async function fetchWithRetry(url: string, maxRetries = 5): Promise<Response> {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Flow API ${res.status} after ${maxRetries + 1} attempts: ${url}`);
      }
      console.warn(`  ⚠ HTTP ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(delay);
      delay *= 2;
    } else {
      throw new Error(`Flow API ${res.status}: ${await res.text().catch(() => "")}`);
    }
  }
  throw new Error("unreachable");
}

/**
 * Extract a named field from a Cadence JSON-CDC composite value's fields array.
 */
function getCadenceField(fields: CadenceField[], name: string): unknown {
  const f = fields.find((x) => x.name === name);
  return f?.value?.value ?? null;
}

/**
 * Parse the base64-encoded Cadence JSON-CDC event payload.
 */
function decodePayload(base64: string): { id: string; fields: CadenceField[] } | null {
  try {
    const json = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
    return { id: json.value?.id ?? "", fields: json.value?.fields ?? [] };
  } catch {
    return null;
  }
}

/**
 * Parse an NFTStorefrontV2.ListingCompleted event into a sale (or null if not purchased).
 */
function parseStorefrontEvent(
  fields: CadenceField[],
  transactionId: string,
  blockTimestamp: string,
): ParsedSale | null {
  const purchased = getCadenceField(fields, "purchased");
  if (purchased !== true) return null;

  const nftId = String(getCadenceField(fields, "nftID") ?? "");
  const priceStr = String(getCadenceField(fields, "salePrice") ?? "0");
  const price = parseFloat(priceStr);
  if (!nftId || !price || price <= 0) return null;

  const seller = (getCadenceField(fields, "storefrontAddress") as string) ?? null;
  const buyer = (getCadenceField(fields, "buyer") as string) ?? null;

  return { nftId, price, seller, buyer, transactionId, blockTimestamp, marketplace: "top_shot" };
}

/**
 * Parse a Market.MomentPurchased event into a sale.
 */
function parseMarketEvent(
  fields: CadenceField[],
  transactionId: string,
  blockTimestamp: string,
): ParsedSale | null {
  const nftId = String(getCadenceField(fields, "id") ?? "");
  const priceStr = String(getCadenceField(fields, "price") ?? "0");
  const price = parseFloat(priceStr);
  if (!nftId || !price || price <= 0) return null;

  const seller = (getCadenceField(fields, "seller") as string) ?? null;

  return { nftId, price, seller, buyer: null, transactionId, blockTimestamp, marketplace: "top_shot_legacy" };
}

// ── Progress tracking ───────────────────────────────────────────────────────

async function loadProgress(): Promise<ProgressRow | null> {
  const { data, error } = await supabase
    .from("flow_backfill_progress")
    .select("*")
    .eq("id", "singleton")
    .single();
  if (error || !data) return null;
  return data as ProgressRow;
}

async function saveProgress(row: ProgressRow): Promise<void> {
  await supabase.from("flow_backfill_progress").upsert(
    {
      id: "singleton",
      ...row,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

// ── Edition lookup ──────────────────────────────────────────────────────────

let collectionId: string | null = null;

async function getCollectionId(): Promise<string | null> {
  if (collectionId) return collectionId;
  const { data } = await supabase
    .from("collections")
    .select("id")
    .eq("slug", "nba_top_shot")
    .single();
  collectionId = data?.id ?? null;
  return collectionId;
}

/**
 * Batch-lookup nft_ids → edition info.
 * Checks moments table first, then falls back to sales table.
 */
async function lookupEditions(
  nftIds: string[],
): Promise<Map<string, { edition_id: string; collection_id: string; serial_number: number | null }>> {
  const result = new Map<string, { edition_id: string; collection_id: string; serial_number: number | null }>();
  if (nftIds.length === 0) return result;

  // Layer 1: moments table
  const { data: momentRows } = await supabase
    .from("moments")
    .select("nft_id, edition_id, collection_id, serial_number")
    .in("nft_id", nftIds);

  for (const row of momentRows ?? []) {
    if (row.nft_id && row.edition_id && row.collection_id) {
      result.set(String(row.nft_id), {
        edition_id: row.edition_id,
        collection_id: row.collection_id,
        serial_number: row.serial_number ?? null,
      });
    }
  }

  // Layer 2: sales table for any remaining
  const missing = nftIds.filter((id) => !result.has(id));
  if (missing.length > 0) {
    const { data: salesRows } = await supabase
      .from("sales")
      .select("nft_id, edition_id, collection_id, serial_number")
      .in("nft_id", missing)
      .not("nft_id", "is", null);

    for (const row of salesRows ?? []) {
      if (row.nft_id && row.edition_id && !result.has(String(row.nft_id))) {
        result.set(String(row.nft_id), {
          edition_id: row.edition_id,
          collection_id: row.collection_id,
          serial_number: row.serial_number ?? null,
        });
      }
    }
  }

  return result;
}

// ── Fetch events from Flow REST API ─────────────────────────────────────────

interface FlowEvent {
  type: string;
  transaction_id: string;
  transaction_index: string;
  event_index: string;
  payload: string; // base64
}

interface FlowBlockEvents {
  block_id: string;
  block_height: string;
  block_timestamp: string;
  events: FlowEvent[];
}

async function fetchEvents(
  eventType: string,
  startHeight: number,
  endHeight: number,
): Promise<FlowBlockEvents[]> {
  const url = `${FLOW_REST}/events?type=${encodeURIComponent(eventType)}&start_height=${startHeight}&end_height=${endHeight}`;
  const res = await fetchWithRetry(url);
  const data = await res.json();
  // The API returns an array of block-level event groups
  return (Array.isArray(data) ? data : []) as FlowBlockEvents[];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Flow Blockchain Backfill — NBA Top Shot Sales");
  console.log("═══════════════════════════════════════════════════════");

  // Resolve NBA Top Shot collection ID
  const colId = await getCollectionId();
  if (!colId) {
    console.error("Could not find nba_top_shot collection in Supabase");
    process.exit(1);
  }
  console.log(`Collection ID: ${colId}`);

  // Determine block range
  const envStart = process.env.START_HEIGHT ? parseInt(process.env.START_HEIGHT, 10) : DEFAULT_START;
  const envEnd = process.env.END_HEIGHT ? parseInt(process.env.END_HEIGHT, 10) : DEFAULT_END;

  // Check for resume point
  const progress = await loadProgress();
  let startHeight = envStart;
  if (progress && progress.last_processed_height >= envStart) {
    startHeight = progress.last_processed_height + BATCH_SIZE;
    console.log(`Resuming from height ${startHeight} (previous run processed to ${progress.last_processed_height})`);
  }
  const endHeight = envEnd;

  const totalBlocks = endHeight - startHeight;
  console.log(`Block range: ${startHeight} → ${endHeight} (${totalBlocks.toLocaleString()} blocks)`);
  console.log(`Estimated batches: ${Math.ceil(totalBlocks / BATCH_SIZE).toLocaleString()}`);
  console.log("");

  // Counters
  let totalEventsFound = progress?.total_events_found ?? 0;
  let totalInserted = progress?.total_inserted ?? 0;
  let totalSkipped = progress?.total_skipped ?? 0;
  let editionsMissing = 0;
  const startTime = Date.now();
  let lastLogHeight = startHeight;

  for (let batchStart = startHeight; batchStart < endHeight; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, endHeight);

    // Fetch both event types in parallel
    const [storefrontBlocks, marketBlocks] = await Promise.all([
      fetchEvents(EVENT_STOREFRONT, batchStart, batchEnd),
      fetchEvents(EVENT_MARKET, batchStart, batchEnd),
    ]);

    // Parse events into sales
    const sales: ParsedSale[] = [];

    for (const block of storefrontBlocks) {
      for (const evt of block.events ?? []) {
        const decoded = decodePayload(evt.payload);
        if (!decoded) continue;
        const sale = parseStorefrontEvent(decoded.fields, evt.transaction_id, block.block_timestamp);
        if (sale) sales.push(sale);
      }
    }

    for (const block of marketBlocks) {
      for (const evt of block.events ?? []) {
        const decoded = decodePayload(evt.payload);
        if (!decoded) continue;
        const sale = parseMarketEvent(decoded.fields, evt.transaction_id, block.block_timestamp);
        if (sale) sales.push(sale);
      }
    }

    totalEventsFound += sales.length;

    if (sales.length > 0) {
      // Dedup by transaction_id within batch
      const uniqueSales = new Map<string, ParsedSale>();
      for (const s of sales) {
        uniqueSales.set(s.transactionId, s);
      }
      const dedupedSales = [...uniqueSales.values()];

      // Look up editions for all nft_ids in this batch
      const nftIds = [...new Set(dedupedSales.map((s) => s.nftId))];
      const editionMap = await lookupEditions(nftIds);

      // Build insert rows
      const rows: object[] = [];
      for (const sale of dedupedSales) {
        const info = editionMap.get(sale.nftId);
        if (!info) {
          editionsMissing++;
          totalSkipped++;
          continue;
        }

        rows.push({
          edition_id: info.edition_id,
          collection_id: info.collection_id,
          serial_number: info.serial_number ?? 0,
          nft_id: sale.nftId,
          price_usd: sale.price,
          price_native: null,
          currency: "DUC",
          marketplace: sale.marketplace,
          transaction_hash: sale.transactionId,
          sold_at: sale.blockTimestamp,
          seller_address: sale.seller,
          buyer_address: sale.buyer,
        });
      }

      // Batch insert with ON CONFLICT DO NOTHING via ignoreDuplicates
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const batch = rows.slice(i, i + INSERT_BATCH);
        const { error, count } = await supabase.from("sales").insert(batch, { count: "exact" });
        if (error) {
          if (error.code === "23505" || error.message?.includes("duplicate")) {
            totalSkipped += batch.length;
          } else {
            console.error(`  Insert error at height ${batchStart}: ${error.message}`);
            totalSkipped += batch.length;
          }
        } else {
          totalInserted += count ?? batch.length;
        }
      }
    }

    // Save progress
    await saveProgress({
      last_processed_height: batchEnd,
      total_events_found: totalEventsFound,
      total_inserted: totalInserted,
      total_skipped: totalSkipped,
    });

    // Log progress every LOG_EVERY blocks
    if (batchStart - lastLogHeight >= LOG_EVERY || batchEnd >= endHeight) {
      const elapsed = (Date.now() - startTime) / 1000;
      const blocksProcessed = batchEnd - startHeight;
      const blocksRemaining = endHeight - batchEnd;
      const blocksPerSec = blocksProcessed / (elapsed || 1);
      const etaSeconds = blocksRemaining / (blocksPerSec || 1);
      const etaMin = Math.round(etaSeconds / 60);

      console.log(
        `[${new Date().toISOString()}] ` +
          `Height ${batchStart.toLocaleString()}–${batchEnd.toLocaleString()} | ` +
          `Events: ${totalEventsFound.toLocaleString()} | ` +
          `Inserted: ${totalInserted.toLocaleString()} | ` +
          `Skipped: ${totalSkipped.toLocaleString()} | ` +
          `Missing editions: ${editionsMissing.toLocaleString()} | ` +
          `ETA: ${etaMin}min`,
      );
      lastLogHeight = batchStart;
    }

    // Rate limit delay
    await sleep(DELAY_MS);
  }

  // Final summary
  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Backfill Complete");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Total events found:     ${totalEventsFound.toLocaleString()}`);
  console.log(`  Total inserted:         ${totalInserted.toLocaleString()}`);
  console.log(`  Total skipped/dupes:    ${totalSkipped.toLocaleString()}`);
  console.log(`  Editions missing:       ${editionsMissing.toLocaleString()}`);
  console.log(`  Elapsed:                ${totalElapsed} min`);
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
