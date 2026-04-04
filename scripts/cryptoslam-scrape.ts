/**
 * scripts/cryptoslam-scrape.ts
 *
 * Scrapes historical NBA Top Shot sales from CryptoSlam for 2024–2025 and
 * inserts them into Supabase. CryptoSlam's API may require authentication
 * or specific headers — the script logs raw responses on first page to help
 * debug the actual data shape.
 *
 * Env vars:
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY               — Supabase admin key
 *   CRYPTOSLAM_API_KEY                      — API key (if required)
 *
 * Usage:
 *   npx tsx scripts/cryptoslam-scrape.ts
 */

import { createClient } from "@supabase/supabase-js";

// ── Config ──────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
const LOG_EVERY = 100; // log progress every N pages
const INSERT_BATCH = 50;
const DELAY_MS = 200; // ms between page fetches
const MAX_RETRIES = 5;

// Date range filter
const DATE_START = "2024-01-01T00:00:00Z";
const DATE_END = "2025-12-31T23:59:59Z";

// CryptoSlam API endpoints to try in order
const API_ENDPOINTS = [
  "https://api.cryptoslam.io/api/sale-records?collectionSlug=nba-top-shot",
  "https://api.cryptoslam.io/v1/collections/nba-top-shot/sales",
  "https://api.cryptoslam.io/v2/nba-top-shot/sales",
  "https://cryptoslam.io/api/nba-top-shot/sales",
];

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, headers: Record<string, string> = {}): Promise<Response> {
  let delay = 1000;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "RipPacksCity/1.0",
        ...headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`CryptoSlam API ${res.status} after ${MAX_RETRIES + 1} attempts: ${url}`);
      }
      console.warn(`  HTTP ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      delay *= 2;
    } else {
      const body = await res.text().catch(() => "");
      throw new Error(`CryptoSlam API ${res.status}: ${body.slice(0, 500)}`);
    }
  }
  throw new Error("unreachable");
}

// ── Types ───────────────────────────────────────────────────────────────────

// Expected CryptoSlam sale record — fields will be confirmed by raw log output
interface CryptoSlamSale {
  transactionHash?: string;
  transaction_hash?: string;
  txHash?: string;
  hash?: string;
  price?: number;
  priceUSD?: number;
  price_usd?: number;
  nftId?: string;
  nft_id?: string;
  tokenId?: string;
  token_id?: string;
  saleDate?: string;
  sale_date?: string;
  soldAt?: string;
  sold_at?: string;
  timestamp?: string;
  sellerAddress?: string;
  seller_address?: string;
  seller?: string;
  buyerAddress?: string;
  buyer_address?: string;
  buyer?: string;
}

/**
 * Normalize a CryptoSlam sale record to our internal format.
 * Handles multiple possible field naming conventions.
 */
function normalizeSale(raw: CryptoSlamSale): {
  txHash: string | null;
  price: number | null;
  nftId: string | null;
  soldAt: string | null;
  seller: string | null;
  buyer: string | null;
} {
  return {
    txHash: raw.transactionHash ?? raw.transaction_hash ?? raw.txHash ?? raw.hash ?? null,
    price: raw.priceUSD ?? raw.price_usd ?? raw.price ?? null,
    nftId: raw.nftId ?? raw.nft_id ?? raw.tokenId ?? raw.token_id ?? null,
    soldAt: raw.saleDate ?? raw.sale_date ?? raw.soldAt ?? raw.sold_at ?? raw.timestamp ?? null,
    seller: raw.sellerAddress ?? raw.seller_address ?? raw.seller ?? null,
    buyer: raw.buyerAddress ?? raw.buyer_address ?? raw.buyer ?? null,
  };
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

async function lookupEditions(
  nftIds: string[],
): Promise<Map<string, { edition_id: string; collection_id: string; serial_number: number | null }>> {
  const result = new Map<string, { edition_id: string; collection_id: string; serial_number: number | null }>();
  if (nftIds.length === 0) return result;

  // Check moments table
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

  // Fallback: check sales table
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

// ── API endpoint discovery ──────────────────────────────────────────────────

async function discoverEndpoint(): Promise<string | null> {
  const apiKey = process.env.CRYPTOSLAM_API_KEY;
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;

  for (const base of API_ENDPOINTS) {
    const testUrl = `${base}${base.includes("?") ? "&" : "?"}page=1&pageSize=1`;
    console.log(`Testing endpoint: ${testUrl}`);
    try {
      const res = await fetch(testUrl, {
        headers: { "Accept": "application/json", "User-Agent": "RipPacksCity/1.0", ...headers },
        signal: AbortSignal.timeout(10_000),
      });
      console.log(`  Status: ${res.status}`);
      if (res.ok) {
        const body = await res.json();
        console.log("  Response structure (first 2000 chars):");
        console.log(JSON.stringify(body, null, 2).slice(0, 2000));
        return base;
      }
      const text = await res.text().catch(() => "");
      console.log(`  Body: ${text.slice(0, 500)}`);
    } catch (err) {
      console.log(`  Error: ${err}`);
    }
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  CryptoSlam Historical Scraper — NBA Top Shot");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Date range: ${DATE_START} → ${DATE_END}`);
  console.log("");

  // Resolve NBA Top Shot collection ID
  const colId = await getCollectionId();
  if (!colId) {
    console.error("Could not find nba_top_shot collection in Supabase");
    process.exit(1);
  }
  console.log(`Collection ID: ${colId}`);

  // Discover working endpoint
  console.log("\nDiscovering CryptoSlam API endpoint...");
  const discoveredUrl = await discoverEndpoint();
  if (!discoveredUrl) {
    console.error("\nAll CryptoSlam API endpoints returned errors.");
    console.error("Possible fixes:");
    console.error("  1. Set CRYPTOSLAM_API_KEY env var if you have an API key");
    console.error("  2. Check https://developer.cryptoslam.io for current API docs");
    console.error("  3. The API may require authentication — contact CryptoSlam");
    process.exit(1);
    throw new Error("unreachable"); // help tsc narrow type
  }
  const baseUrl: string = discoveredUrl;
  console.log(`\nUsing endpoint: ${baseUrl}\n`);

  const apiKey = process.env.CRYPTOSLAM_API_KEY;
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;

  // Counters
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalEditionsMissing = 0;
  let totalPages = 0;
  let emptyPages = 0;
  const startTime = Date.now();

  // Paginate through all pages
  for (let page = 1; ; page++) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}page=${page}&pageSize=${PAGE_SIZE}`;

    let data: unknown;
    try {
      const res = await fetchWithRetry(url, headers);
      data = await res.json();
    } catch (err) {
      console.error(`Failed to fetch page ${page}: ${err}`);
      break;
    }

    // Extract records array — handle various response shapes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const records: CryptoSlamSale[] = Array.isArray(data)
      ? data
      : Array.isArray((data as any)?.data)
        ? (data as any).data
        : Array.isArray((data as any)?.results)
          ? (data as any).results
          : Array.isArray((data as any)?.records)
            ? (data as any).records
            : Array.isArray((data as any)?.sales)
              ? (data as any).sales
              : [];

    if (records.length === 0) {
      emptyPages++;
      if (emptyPages >= 3) {
        console.log(`3 consecutive empty pages at page ${page}, stopping.`);
        break;
      }
      continue;
    }
    emptyPages = 0;
    totalPages = page;

    // Normalize and filter by date range
    const normalized = records
      .map(normalizeSale)
      .filter((s) => {
        if (!s.soldAt || !s.txHash) return false;
        return s.soldAt >= DATE_START && s.soldAt <= DATE_END;
      });

    // If all records are outside our date range and before it, we've gone past
    const allBefore = records.every((r) => {
      const d = r.saleDate ?? r.sale_date ?? r.soldAt ?? r.sold_at ?? r.timestamp ?? "";
      return d < DATE_START;
    });
    if (allBefore && records.length > 0) {
      console.log(`All records on page ${page} are before ${DATE_START}, stopping.`);
      break;
    }

    if (normalized.length === 0) {
      await sleep(DELAY_MS);
      continue;
    }

    // Look up editions
    const nftIds = [...new Set(normalized.map((s) => s.nftId).filter(Boolean) as string[])];
    const editionMap = await lookupEditions(nftIds);

    // Build insert rows
    const rows: object[] = [];
    for (const sale of normalized) {
      if (!sale.nftId || !sale.txHash) {
        totalSkipped++;
        continue;
      }

      const info = editionMap.get(sale.nftId);
      if (!info) {
        totalEditionsMissing++;
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
        currency: "USD",
        marketplace: "cryptoslam",
        transaction_hash: sale.txHash,
        sold_at: sale.soldAt,
        seller_address: sale.seller,
        buyer_address: sale.buyer,
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
          console.error(`  Insert error on page ${page}: ${error.message}`);
          totalSkipped += batch.length;
        }
      } else {
        totalInserted += count ?? batch.length;
      }
    }

    // Log progress
    if (page % LOG_EVERY === 0) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(
        `[Page ${page}] ` +
          `Inserted: ${totalInserted.toLocaleString()} | ` +
          `Skipped: ${totalSkipped.toLocaleString()} | ` +
          `Missing editions: ${totalEditionsMissing.toLocaleString()} | ` +
          `Elapsed: ${elapsed}min`,
      );
    }

    await sleep(DELAY_MS);
  }

  // Final summary
  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  CryptoSlam Scrape Complete");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Pages processed:        ${totalPages.toLocaleString()}`);
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
