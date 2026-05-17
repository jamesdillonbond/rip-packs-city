// workers/pack-events-ingest/index.ts
//
// Top Shot pack lifecycle classifier — advances two cursors stored in
// event_cursor (topshot_pack_purchases + topshot_pack_opens), indexes
// secondary-market pack purchases and pack opens, and backfills
// moment_acquisitions with verified pack_rip provenance (replacing the
// 'cache-refresh:%' placeholders left by earlier wallet-walk ingest).
//
// Auth:    POST /          Bearer INGEST_SECRET_TOKEN  (live ingest)
//          POST /backfill  Bearer INGEST_SECRET_TOKEN  (historical backfill)
// Health:  GET  /health    unauthenticated; returns {ok: true}
//
// Live mode (POST /) advances topshot_pack_purchases / topshot_pack_opens
// toward sealed tip. Backfill mode (POST /backfill) advances
// topshot_pack_{purchases,opens}_backfill toward TARGET_END_BLOCK
// (151610000 — the seed point of the live cursors), preventing overlap
// with the live ingest range.
//
// Response shape (both endpoints, always 200, even on per-cursor failure
// so cron retries cleanly):
//   {
//     ok: boolean,                      // false iff one or both cursors errored
//     purchases: { from_block, to_block, chunks_processed, events_processed, rows_inserted, caught_up },
//     opens:     { from_block, to_block, chunks_processed, rips_inserted, moments_linked, caught_up },
//     sealed_tip: number,
//     duration_ms: number,
//     errors?:   [{ cursor, message }],
//   }
//
// Each invocation loops multiple 250-block chunks per cursor until one
// of these is true:
//   live:     (a) cursor caught up to within 50 blocks of sealed tip,
//             (b) shared 25,000 ms soft budget across BOTH cursors exceeded,
//             (c) 20 chunks processed for this cursor,
//             (d) chunk threw (cursor NOT advanced, error recorded).
//   backfill: (a) cursor advanced past or equal to TARGET_END_BLOCK,
//             (b) shared 25,000 ms soft budget across BOTH cursors exceeded,
//             (c) 40 chunks processed for this cursor (higher cap — backfill
//                 should grind faster than live since it never waits on tip),
//             (d) chunk threw.
// Purchases runs first, then opens — the opens cursor only gets whatever
// budget remains after purchases. caught_up means cursor within 50 blocks
// of sealed tip (live) or cursor >= TARGET_END_BLOCK (backfill).
//
// Subrequest budget: this worker batches all Supabase writes to keep
// total subrequests roughly constant per invocation regardless of how
// many chunks are processed. Per cursor: rows accumulate in-memory
// during the chunk loop, then flush in a single batch insert after
// the loop. Cursor advance is deferred to one final write at the very
// end. If the batch flush throws, the cursor does NOT advance and the
// next cron tick re-attempts the entire accumulated range (idempotent
// because every insert uses ON CONFLICT DO NOTHING).

import { createClient, SupabaseClient } from "@supabase/supabase-js";

interface Env {
  INGEST_SECRET_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

type Mode = "live" | "backfill";

const FLOW_REST = "https://rest-mainnet.onflow.org";
const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"; // Top Shot
const CHUNK_SIZE = 250;
const REQUEST_TIMEOUT_MS = 20_000;
const SOFT_BUDGET_MS = 25_000;
const MAX_CHUNKS_PER_CURSOR_LIVE = 20;
const MAX_CHUNKS_PER_CURSOR_BACKFILL = 40;
const CAUGHT_UP_THRESHOLD = 50;
const SEALED_TIP_TTL_MS = 60_000;

// Seed point of the live cursors. Backfill stops here so historical and
// live ranges never overlap.
const TARGET_END_BLOCK = 151_610_000;

const CURSOR_PURCHASES = "topshot_pack_purchases";
const CURSOR_OPENS = "topshot_pack_opens";
const CURSOR_PURCHASES_BACKFILL = "topshot_pack_purchases_backfill";
const CURSOR_OPENS_BACKFILL = "topshot_pack_opens_backfill";

const EVT_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted";
const EVT_PACKNFT_DEPOSIT = "A.0b2a3299cc857e29.PackNFT.Deposit";
const EVT_PACKNFT_OPENED = "A.0b2a3299cc857e29.PackNFT.Opened";
const EVT_TOPSHOT_DEPOSIT = "A.0b2a3299cc857e29.TopShot.Deposit";
const EVT_TOPSHOT_WITHDRAW = "A.0b2a3299cc857e29.TopShot.Withdraw";
const PACK_NFT_TYPE_ID = "A.0b2a3299cc857e29.PackNFT.NFT";

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonError(status: number, error: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function healthOk(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      worker: "pack-events-ingest",
      cursors: [
        CURSOR_PURCHASES,
        CURSOR_OPENS,
        CURSOR_PURCHASES_BACKFILL,
        CURSOR_OPENS_BACKFILL,
      ],
      chunk_size: CHUNK_SIZE,
      collection_id: COLLECTION_ID,
      target_end_block: TARGET_END_BLOCK,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function zeroPurchases() {
  return {
    from_block: 0,
    to_block: 0,
    chunks_processed: 0,
    events_processed: 0,
    rows_inserted: 0,
    caught_up: false,
  };
}

function zeroOpens() {
  return {
    from_block: 0,
    to_block: 0,
    chunks_processed: 0,
    rips_inserted: 0,
    moments_linked: 0,
    caught_up: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cadence JSON decoder (mirrors lib/cdc and pinnacle-events-ingest cron)
// ─────────────────────────────────────────────────────────────────────────────

function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(unwrapCdc);
  if (typeof node !== "object") return node;
  const { type, value } = node as { type?: string; value?: unknown };
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrapCdc(value);
      case "Bool":
      case "String":
      case "Address":
      case "Path":
      case "Character":
        return value;
      case "Int":
      case "UInt":
      case "Int8":
      case "Int16":
      case "Int32":
      case "Int64":
      case "Int128":
      case "Int256":
      case "UInt8":
      case "UInt16":
      case "UInt32":
      case "UInt64":
      case "UInt128":
      case "UInt256":
      case "Word8":
      case "Word16":
      case "Word32":
      case "Word64":
      case "Fix64":
      case "UFix64":
        return value;
      case "Array":
        return (value as unknown[]).map(unwrapCdc);
      case "Dictionary": {
        const arr = value as Array<{ key: unknown; value: unknown }>;
        const out: Record<string, unknown> = {};
        for (const entry of arr) out[String(unwrapCdc(entry.key))] = unwrapCdc(entry.value);
        return out;
      }
      case "Struct":
      case "Resource":
      case "Event":
      case "Contract":
      case "Enum": {
        const out: Record<string, unknown> = {};
        const v = value as { fields?: Array<{ name: string; value: unknown }> };
        for (const f of v.fields ?? []) out[f.name] = unwrapCdc(f.value);
        return out;
      }
      default:
        return value;
    }
  }
  return node;
}

function extractTypeId(field: unknown): string | undefined {
  if (typeof field === "string") return field;
  if (field && typeof field === "object") {
    const st = (field as Record<string, unknown>).staticType;
    if (typeof st === "string") return st;
    if (st && typeof st === "object") {
      const id = (st as Record<string, unknown>).typeID;
      if (typeof id === "string") return id;
    }
  }
  return undefined;
}

// Take the substring after the last dot in salePaymentVaultType with the
// trailing `.Vault` stripped, then map the known contract names to the
// canonical RPC short codes.
function deriveCurrency(vaultTypeId: string | undefined): string {
  if (!vaultTypeId) return "UNKNOWN";
  const trimmed = vaultTypeId.replace(/\.Vault$/, "");
  const idx = trimmed.lastIndexOf(".");
  const contract = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  switch (contract) {
    case "DapperUtilityCoin":
      return "DUC";
    case "FlowToken":
      return "FLOW";
    case "FiatToken":
      return "USDC";
    default:
      return contract;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow REST fetchers
// ─────────────────────────────────────────────────────────────────────────────

interface FlowEventBlock {
  block_height: string;
  block_timestamp: string;
  events?: Array<{ payload: string; transaction_id: string; event_index: number; type: string }>;
}

interface FlatEvent {
  block_height: number;
  block_timestamp: string;
  transaction_id: string;
  event_index: number;
  type: string;
  decoded: Record<string, unknown>;
}

async function fetchEventChunk(
  eventType: string,
  start: number,
  end: number,
): Promise<FlatEvent[]> {
  const url =
    `${FLOW_REST}/v1/events?type=${encodeURIComponent(eventType)}` +
    `&start_height=${start}&end_height=${end}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(
      `flow rest /v1/events HTTP ${res.status} type=${eventType} range=${start}..${end}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const blocks = (await res.json()) as FlowEventBlock[];
  const flat: FlatEvent[] = [];
  for (const blk of Array.isArray(blocks) ? blocks : []) {
    const bh = Number(blk.block_height);
    const bts = blk.block_timestamp;
    for (const evt of blk.events ?? []) {
      let decoded: Record<string, unknown> = {};
      try {
        const bytes = Uint8Array.from(atob(evt.payload), (c) => c.charCodeAt(0));
        const utf8 = new TextDecoder().decode(bytes);
        decoded = unwrapCdc(JSON.parse(utf8)) as Record<string, unknown>;
      } catch {
        // leave decoded as {} — caller will skip rows with missing fields
      }
      flat.push({
        block_height: bh,
        block_timestamp: bts,
        transaction_id: evt.transaction_id,
        event_index: evt.event_index,
        type: evt.type,
        decoded,
      });
    }
  }
  return flat;
}

async function getSealedHeight(): Promise<number> {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`flow rest /v1/blocks?height=sealed HTTP ${res.status}`);
  const json = (await res.json()) as Array<{ header: { height: string } }>;
  return Number(json[0]?.header?.height ?? 0);
}

// Used to derive seller_address per the spec ("the transaction's payer field").
const txPayerCache = new Map<string, string | null>();
async function getTransactionPayer(txId: string): Promise<string | null> {
  if (txPayerCache.has(txId)) return txPayerCache.get(txId) ?? null;
  try {
    const res = await fetch(`${FLOW_REST}/v1/transactions/${txId}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      txPayerCache.set(txId, null);
      return null;
    }
    const json = (await res.json()) as { payer?: string };
    const payer = typeof json.payer === "string" ? json.payer : null;
    txPayerCache.set(txId, payer);
    return payer;
  } catch {
    txPayerCache.set(txId, null);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor read / write — batched read at start, single write per cursor at end
// ─────────────────────────────────────────────────────────────────────────────

async function readCursors(sb: SupabaseClient, ids: string[]): Promise<Record<string, number>> {
  const { data, error } = await sb
    .from("event_cursor")
    .select("id, last_processed_block")
    .in("id", ids);
  if (error) throw new Error(`event_cursor batch read: ${error.message}`);
  const map: Record<string, number> = {};
  for (const row of (data ?? []) as Array<{ id: string; last_processed_block: number }>) {
    map[row.id] = Number(row.last_processed_block);
  }
  for (const id of ids) {
    if (map[id] === undefined) {
      throw new Error(`event_cursor row missing for id=${id} — seed it before deploying`);
    }
  }
  return map;
}

async function writeCursor(sb: SupabaseClient, id: string, height: number): Promise<void> {
  const { error } = await sb
    .from("event_cursor")
    .upsert({ id, last_processed_block: height, updated_at: new Date().toISOString() });
  if (error) throw new Error(`event_cursor write ${id} -> ${height}: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor 1: topshot_pack_purchases — pure event-fetch, no DB writes
// ─────────────────────────────────────────────────────────────────────────────

interface PurchaseRow {
  collection_id: string;
  pack_nft_id: string;
  buyer_address: string;
  seller_address: string | null;
  storefront_resource_id: string | null;
  listing_resource_id: string | null;
  sale_price: number | null;
  sale_currency: string;
  payment_vault_type: string | null;
  custom_id: string | null;
  commission_amount: number | null;
  pack_name: null;
  tx_hash: string;
  block_height: number;
  sealed_at: string;
}

interface PurchasesChunkResult {
  rows: PurchaseRow[];
  events_processed: number;
}

async function fetchPurchasesChunk(
  fromBlock: number,
  toBlock: number,
): Promise<PurchasesChunkResult> {
  if (fromBlock > toBlock) {
    return { rows: [], events_processed: 0 };
  }

  const [listings, packDeposits] = await Promise.all([
    fetchEventChunk(EVT_LISTING_COMPLETED, fromBlock, toBlock),
    fetchEventChunk(EVT_PACKNFT_DEPOSIT, fromBlock, toBlock),
  ]);

  // Index PackNFT.Deposit by (tx_id, nft_id) so each ListingCompleted
  // can pair with the same-tx deposit that hands the pack to the buyer.
  const depositByTxAndId = new Map<string, FlatEvent>();
  for (const dep of packDeposits) {
    const nftId = dep.decoded["id"];
    if (nftId === undefined || nftId === null) continue;
    depositByTxAndId.set(`${dep.transaction_id}:${String(nftId)}`, dep);
  }

  const rows: PurchaseRow[] = [];
  let eventsProcessed = 0;

  for (const lc of listings) {
    eventsProcessed++;
    const d = lc.decoded;
    const nftTypeId = extractTypeId(d["nftType"]);
    if (nftTypeId !== PACK_NFT_TYPE_ID) continue;
    if (d["purchased"] !== true) continue;

    const nftID = d["nftID"];
    if (nftID === undefined || nftID === null) continue;
    const nftIdStr = String(nftID);

    const dep = depositByTxAndId.get(`${lc.transaction_id}:${nftIdStr}`);
    if (!dep) continue; // pack handover never deposited — not a real purchase
    const buyerAddress = dep.decoded["to"];
    if (typeof buyerAddress !== "string") continue;

    const sellerAddress = await getTransactionPayer(lc.transaction_id);

    const vaultTypeId = extractTypeId(d["salePaymentVaultType"]);
    const salePrice = d["salePrice"] === undefined || d["salePrice"] === null
      ? null
      : parseFloat(String(d["salePrice"]));
    const commissionAmount = d["commissionAmount"] === undefined || d["commissionAmount"] === null
      ? null
      : parseFloat(String(d["commissionAmount"]));

    rows.push({
      collection_id: COLLECTION_ID,
      pack_nft_id: nftIdStr,
      buyer_address: buyerAddress,
      seller_address: sellerAddress,
      storefront_resource_id: d["storefrontResourceID"] != null ? String(d["storefrontResourceID"]) : null,
      listing_resource_id: d["listingResourceID"] != null ? String(d["listingResourceID"]) : null,
      sale_price: Number.isFinite(salePrice as number) ? salePrice : null,
      sale_currency: deriveCurrency(vaultTypeId),
      payment_vault_type: vaultTypeId ?? null,
      custom_id: d["customID"] != null ? String(d["customID"]) : null,
      commission_amount: Number.isFinite(commissionAmount as number) ? commissionAmount : null,
      pack_name: null,
      tx_hash: lc.transaction_id,
      block_height: lc.block_height,
      sealed_at: lc.block_timestamp,
    });
  }

  return { rows, events_processed: eventsProcessed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor 2: topshot_pack_opens — pure event-fetch, no DB writes
// ─────────────────────────────────────────────────────────────────────────────

interface RipRow {
  collection_id: string;
  pack_nft_id: string;
  opener_address: string;
  moments_pulled: number;
  total_fmv_at_rip: null;
  tx_hash: string;
  block_height: number;
  sealed_at: string;
}

interface MomentTemplate {
  nft_id: string;
  wallet: string;
  source_address: string | null;
  rip_tx_hash: string;     // join key for source_pack_rip_id resolution
  acquired_date: string;
}

interface PlaceholderPair {
  nft_id: string;
  wallet: string;
}

interface OpensChunkResult {
  rips: RipRow[];
  momentTemplates: MomentTemplate[];
  placeholders: PlaceholderPair[];
}

async function fetchOpensChunk(
  fromBlock: number,
  toBlock: number,
): Promise<OpensChunkResult> {
  if (fromBlock > toBlock) {
    return { rips: [], momentTemplates: [], placeholders: [] };
  }

  // TopShot.Withdraw is fetched alongside Deposit so each minted moment
  // can be tagged with its reveal-custody source_address. The custody
  // account is typically 0xb6f2481eba4df97b for current pack types but
  // may vary by pack format, so we always read it from the event.
  const [openedEvents, tsDeposits, tsWithdraws] = await Promise.all([
    fetchEventChunk(EVT_PACKNFT_OPENED, fromBlock, toBlock),
    fetchEventChunk(EVT_TOPSHOT_DEPOSIT, fromBlock, toBlock),
    fetchEventChunk(EVT_TOPSHOT_WITHDRAW, fromBlock, toBlock),
  ]);

  // Group same-tx events. A pack open transaction emits:
  //   1× PackNFT.Opened
  //   N× TopShot.Withdraw (from custody)
  //   N× TopShot.Deposit  (to opener)
  const depositsByTx = new Map<string, FlatEvent[]>();
  for (const ev of tsDeposits) {
    (depositsByTx.get(ev.transaction_id) ?? depositsByTx.set(ev.transaction_id, []).get(ev.transaction_id)!).push(ev);
  }
  const withdrawsByTx = new Map<string, FlatEvent[]>();
  for (const ev of tsWithdraws) {
    (withdrawsByTx.get(ev.transaction_id) ?? withdrawsByTx.set(ev.transaction_id, []).get(ev.transaction_id)!).push(ev);
  }

  const rips: RipRow[] = [];
  const momentTemplates: MomentTemplate[] = [];
  const placeholders: PlaceholderPair[] = [];

  for (const opened of openedEvents) {
    const txDeposits = depositsByTx.get(opened.transaction_id) ?? [];
    if (txDeposits.length === 0) continue; // pack opened with no minted moments — skip

    const opener = txDeposits[0].decoded["to"];
    if (typeof opener !== "string") continue;

    const packNftId = opened.decoded["id"];
    if (packNftId === undefined || packNftId === null) continue;

    rips.push({
      collection_id: COLLECTION_ID,
      pack_nft_id: String(packNftId),
      opener_address: opener,
      moments_pulled: txDeposits.length,
      total_fmv_at_rip: null,
      tx_hash: opened.transaction_id,
      block_height: opened.block_height,
      sealed_at: opened.block_timestamp,
    });

    // Index Withdraw events by moment id so each Deposit can find its source.
    const withdrawsForTx = withdrawsByTx.get(opened.transaction_id) ?? [];
    const withdrawByMomentId = new Map<string, FlatEvent>();
    for (const wd of withdrawsForTx) {
      const wid = wd.decoded["id"];
      if (wid !== undefined && wid !== null) withdrawByMomentId.set(String(wid), wd);
    }

    for (const dep of txDeposits) {
      const momentId = dep.decoded["id"];
      if (momentId === undefined || momentId === null) continue;
      const nftIdStr = String(momentId);

      const withdraw = withdrawByMomentId.get(nftIdStr);
      const sourceAddress = withdraw && typeof withdraw.decoded["from"] === "string"
        ? (withdraw.decoded["from"] as string)
        : null;

      placeholders.push({ nft_id: nftIdStr, wallet: opener });
      momentTemplates.push({
        nft_id: nftIdStr,
        wallet: opener,
        source_address: sourceAddress,
        rip_tx_hash: opened.transaction_id,
        acquired_date: opened.block_timestamp,
      });
    }
  }

  return { rips, momentTemplates, placeholders };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch flushers — one Supabase write per group, called after the chunk loop
// ─────────────────────────────────────────────────────────────────────────────

// PostgREST .in() lives in the URL query string. Backfill mode accumulates
// hundreds of pack-open tx hashes over its 40-chunk budget (one observed run
// posted 829 tx_hashes), which blows past the URL-length limit and comes back
// as a 400/HTTP-414 Bad Request. Cap each lookup at 100 tx hashes and run up
// to 4 in parallel so the wall-clock cost stays bounded.
const PACK_RIPS_LOOKUP_CHUNK_SIZE = 100;
const PACK_RIPS_LOOKUP_CONCURRENCY = 4;

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function lookupPackRipIdsByTxHash(
  sb: SupabaseClient,
  txHashes: string[],
): Promise<{ ripIdByTx: Map<string, string>; chunkErrors: Array<{ source: string; message: string }> }> {
  const ripIdByTx = new Map<string, string>();
  const chunkErrors: Array<{ source: string; message: string }> = [];
  if (txHashes.length === 0) return { ripIdByTx, chunkErrors };

  const chunks = chunkArray(txHashes, PACK_RIPS_LOOKUP_CHUNK_SIZE);
  // Process chunks in waves of PACK_RIPS_LOOKUP_CONCURRENCY. Promise.allSettled
  // ensures one chunk's failure doesn't sink siblings — partial results still
  // attribute moment_acquisitions for the rips that did resolve.
  for (let i = 0; i < chunks.length; i += PACK_RIPS_LOOKUP_CONCURRENCY) {
    const wave = chunks.slice(i, i + PACK_RIPS_LOOKUP_CONCURRENCY);
    const settled = await Promise.allSettled(
      wave.map(async (chunk) => {
        const { data, error } = await sb
          .from("pack_rips")
          .select("id, tx_hash")
          .in("tx_hash", chunk);
        if (error) throw new Error(error.message);
        return { chunk, rows: (data ?? []) as Array<{ id: string; tx_hash: string }> };
      }),
    );
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      const chunk = wave[j];
      if (r.status === "fulfilled") {
        for (const row of r.value.rows) ripIdByTx.set(row.tx_hash, row.id);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        chunkErrors.push({
          source: "pack_rips_lookup_chunk",
          message:
            `size=${chunk.length} first=${chunk[0]} last=${chunk[chunk.length - 1]}: ${msg}`.slice(0, 300),
        });
      }
    }
  }
  return { ripIdByTx, chunkErrors };
}

async function flushPurchases(sb: SupabaseClient, rows: PurchaseRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { data, error } = await sb
    .from("pack_purchases")
    .upsert(rows, { onConflict: "tx_hash,listing_resource_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(`pack_purchases batch upsert (${rows.length} rows): ${error.message}`);
  return data?.length ?? 0;
}

async function flushOpens(
  sb: SupabaseClient,
  rips: RipRow[],
  momentTemplates: MomentTemplate[],
  placeholders: PlaceholderPair[],
): Promise<{
  rips_inserted: number;
  moments_linked: number;
  chunk_errors: Array<{ source: string; message: string }>;
}> {
  if (rips.length === 0) return { rips_inserted: 0, moments_linked: 0, chunk_errors: [] };

  // (1) Upsert all rips. ignoreDuplicates: true preserves the existing
  //     semantic that rips_inserted counts only newly inserted rows.
  const { data: insertedRips, error: ripErr } = await sb
    .from("pack_rips")
    .upsert(rips, { onConflict: "tx_hash", ignoreDuplicates: true })
    .select("id, tx_hash");
  if (ripErr) {
    throw new Error(`pack_rips batch upsert (${rips.length} rows): ${ripErr.message}`);
  }
  const ripsInserted = insertedRips?.length ?? 0;

  // (2) SELECT IDs for ALL rip tx_hashes — conflict-skipped rows weren't
  //     returned by the upsert, but moment_acquisitions still needs their
  //     source_pack_rip_id. Chunked + bounded-concurrency so URL-length
  //     limits don't sink the whole batch (~3M-block backfill iterations
  //     can accumulate 800+ tx_hashes in a single 25s window). Individual
  //     chunk failures are collected and returned for pipeline_runs.extra
  //     rather than aborting downstream moment_acquisitions writes — a
  //     partial result is better than zero progress.
  const allTxHashes = Array.from(new Set(rips.map((r) => r.tx_hash)));
  const lookup = await lookupPackRipIdsByTxHash(sb, allTxHashes);
  const ripIdByTx = lookup.ripIdByTx;
  const chunkErrors = lookup.chunkErrors;

  // (3) Delete all cache-refresh placeholders in one statement using a
  //     composite OR filter over the (nft_id, wallet) pairs. Each
  //     placeholder corresponds to one accumulated moment template, so
  //     this is bounded by the number of deposits processed.
  if (placeholders.length > 0) {
    const orFilter = placeholders
      .map((p) => `and(nft_id.eq.${p.nft_id},wallet.eq.${p.wallet})`)
      .join(",");
    const { error: delErr } = await sb
      .from("moment_acquisitions")
      .delete()
      .like("transaction_hash", "cache-refresh:%")
      .or(orFilter);
    if (delErr) {
      throw new Error(
        `moment_acquisitions placeholder delete (${placeholders.length} pairs): ${delErr.message}`,
      );
    }
  }

  // (4) Build moment_acquisitions rows now that we have rip IDs and
  //     insert them in one batch upsert.
  const momentRows: Array<Record<string, unknown>> = [];
  for (const t of momentTemplates) {
    const ripId = ripIdByTx.get(t.rip_tx_hash);
    if (!ripId) continue; // rip somehow missing — skip rather than corrupt FK
    momentRows.push({
      nft_id: t.nft_id,
      collection_id: COLLECTION_ID,
      wallet: t.wallet,
      acquisition_method: "pack_pull",
      acquisition_confidence: "verified",
      acquired_date: t.acquired_date,
      transaction_hash: t.rip_tx_hash,
      source_address: t.source_address,
      source_pack_rip_id: ripId,
    });
  }

  let momentsLinked = 0;
  if (momentRows.length > 0) {
    const { data: insertedMoments, error: insErr } = await sb
      .from("moment_acquisitions")
      .upsert(momentRows, { onConflict: "nft_id,wallet,transaction_hash", ignoreDuplicates: true })
      .select("id");
    if (insErr) {
      throw new Error(
        `moment_acquisitions batch upsert (${momentRows.length} rows): ${insErr.message}`,
      );
    }
    momentsLinked = insertedMoments?.length ?? 0;
  }

  return { rips_inserted: ripsInserted, moments_linked: momentsLinked, chunk_errors: chunkErrors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared per-cursor loop. Both live and backfill iterate 250-block chunks
// from initialCursor toward a moving target (sealed tip in live, fixed
// TARGET_END_BLOCK in backfill). The caller passes a processChunk callback
// that owns its own accumulator; processCursor only manages the loop, the
// shared time budget, and the chunk cap. Cursor advance is the caller's
// responsibility — this function returns the final cursor value reached.
// ─────────────────────────────────────────────────────────────────────────────

async function processCursor(
  cursorId: string,
  mode: Mode,
  initialCursor: number,
  startedMs: number,
  getCurrentSealedTip: () => Promise<number>,
  processChunk: (from: number, to: number) => Promise<void>,
): Promise<{ target: number; chunks: number; errorMsg: string | null }> {
  const maxChunks = mode === "live" ? MAX_CHUNKS_PER_CURSOR_LIVE : MAX_CHUNKS_PER_CURSOR_BACKFILL;
  let target = initialCursor;
  let chunks = 0;
  let errorMsg: string | null = null;

  try {
    while (true) {
      if (Date.now() - startedMs >= SOFT_BUDGET_MS) break;
      if (chunks >= maxChunks) break;

      let from: number;
      let to: number;
      if (mode === "live") {
        const tip = await getCurrentSealedTip();
        if (tip - target <= CAUGHT_UP_THRESHOLD) break;
        from = target + 1;
        to = Math.min(target + CHUNK_SIZE, tip);
      } else {
        if (target >= TARGET_END_BLOCK) break;
        from = target + 1;
        to = Math.min(target + CHUNK_SIZE, TARGET_END_BLOCK);
      }
      if (to < from) break;

      await processChunk(from, to);
      // Defensive clamp: in backfill mode the very last chunk must never
      // overshoot TARGET_END_BLOCK into live territory. `to` is already
      // clamped above, but re-applying min here is cheap and survives any
      // future change that loosens the inner clamp.
      target = mode === "backfill" ? Math.min(to, TARGET_END_BLOCK) : to;
      chunks++;
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[pack-events-ingest] ${cursorId} fetch error: ${errorMsg}`);
  }

  return { target, chunks, errorMsg };
}

// ─────────────────────────────────────────────────────────────────────────────
// pipeline_runs telemetry (2026-05-17)
//
// Both modes (live / backfill) write exactly one row to public.pipeline_runs
// per invocation, fire-and-forget at the end of runIngest. The watchlist
// keys on pipeline=`pack-events-ingest` (live) and
// pipeline=`pack-events-ingest-backfill`. cursor_before / cursor_after carry
// the purchases cursor; extra.opens_* carries the parallel opens cursor.
// ─────────────────────────────────────────────────────────────────────────────

async function logPipelineRun(
  sb: SupabaseClient,
  args: {
    pipeline: string;
    startedAtIso: string;
    rowsFound: number;
    rowsWritten: number;
    rowsSkipped: number;
    ok: boolean;
    error: string | null;
    cursorBefore: string | null;
    cursorAfter: string | null;
    extra: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { error } = await sb.rpc("log_pipeline_run", {
      p_pipeline: args.pipeline,
      p_started_at: args.startedAtIso,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: args.cursorBefore,
      p_cursor_after: args.cursorAfter,
      p_extra: args.extra,
    });
    if (error) {
      console.log(`[${args.pipeline}] log_pipeline_run err: ${error.message}`);
    }
  } catch (err) {
    console.log(
      `[${args.pipeline}] log_pipeline_run threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared request handler — picks cursor pair by mode, runs purchases then
// opens, flushes batches, advances cursors, returns the same response shape
// from POST / and POST /backfill.
// ─────────────────────────────────────────────────────────────────────────────

async function runIngest(env: Env, mode: Mode, startedMs: number): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonError(500, "supabase_env_missing", {
      hint: "wrangler secret put SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY",
    });
  }

  const pipeline = mode === "live" ? "pack-events-ingest" : "pack-events-ingest-backfill";
  const startedAtIso = new Date(startedMs).toISOString();
  const purchasesCursorId = mode === "live" ? CURSOR_PURCHASES : CURSOR_PURCHASES_BACKFILL;
  const opensCursorId = mode === "live" ? CURSOR_OPENS : CURSOR_OPENS_BACKFILL;

  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Shared sealed-tip cache. Refetched only when older than
  // SEALED_TIP_TTL_MS so a busy invocation doesn't hammer the
  // access node once per chunk. Both modes fetch it once at the start
  // so the response always carries a real sealed_tip value; backfill
  // never re-fetches because its stop condition is TARGET_END_BLOCK.
  let cachedSealedTip = await getSealedHeight();
  let lastTipFetchMs = Date.now();
  const getCurrentSealedTip = async (): Promise<number> => {
    if (Date.now() - lastTipFetchMs > SEALED_TIP_TTL_MS) {
      cachedSealedTip = await getSealedHeight();
      lastTipFetchMs = Date.now();
    }
    return cachedSealedTip;
  };

  const errors: Array<{ cursor: string; message: string }> = [];

  // Single batched cursor read replaces 2 separate selects.
  let initialCursors: Record<string, number>;
  try {
    initialCursors = await readCursors(sb, [purchasesCursorId, opensCursorId]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[pack-events-ingest] cursor read fatal: ${msg}`);
    await logPipelineRun(sb, {
      pipeline,
      startedAtIso,
      rowsFound: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      ok: false,
      error: `cursor_read: ${msg}`,
      cursorBefore: null,
      cursorAfter: null,
      extra: {
        mode,
        sealed_tip: cachedSealedTip,
        purchases_cursor_id: purchasesCursorId,
        opens_cursor_id: opensCursorId,
        duration_ms: Date.now() - startedMs,
      },
    });
    return new Response(
      JSON.stringify({
        ok: false,
        purchases: zeroPurchases(),
        opens: zeroOpens(),
        sealed_tip: cachedSealedTip,
        duration_ms: Date.now() - startedMs,
        errors: [{ cursor: "cursor_read", message: msg }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── purchases: chunk-loop fetch, no DB writes inside the loop ───────
  const purchasesInitial = initialCursors[purchasesCursorId];
  let purchasesEvents = 0;
  const purchasesAccumulated: PurchaseRow[] = [];

  const purchasesLoop = await processCursor(
    purchasesCursorId,
    mode,
    purchasesInitial,
    startedMs,
    getCurrentSealedTip,
    async (from, to) => {
      const chunk = await fetchPurchasesChunk(from, to);
      for (const row of chunk.rows) purchasesAccumulated.push(row);
      purchasesEvents += chunk.events_processed;
    },
  );
  if (purchasesLoop.errorMsg) {
    errors.push({ cursor: purchasesCursorId, message: purchasesLoop.errorMsg });
  }
  const purchasesTarget = purchasesLoop.target;
  const purchasesChunks = purchasesLoop.chunks;

  // ── purchases flush: single batch insert, deferred cursor advance ───
  let purchasesActualCursor = purchasesInitial;
  let purchasesRows = 0;
  if (purchasesTarget > purchasesInitial) {
    try {
      purchasesRows = await flushPurchases(sb, purchasesAccumulated);
      purchasesActualCursor = purchasesTarget;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[pack-events-ingest] ${purchasesCursorId} flush error: ${msg}`);
      errors.push({ cursor: purchasesCursorId, message: msg });
    }
  }

  // ── opens: chunk-loop fetch, no DB writes inside the loop ───────────
  const opensInitial = initialCursors[opensCursorId];
  const opensRips: RipRow[] = [];
  const opensTemplates: MomentTemplate[] = [];
  const opensPlaceholders: PlaceholderPair[] = [];

  const opensLoop = await processCursor(
    opensCursorId,
    mode,
    opensInitial,
    startedMs,
    getCurrentSealedTip,
    async (from, to) => {
      const chunk = await fetchOpensChunk(from, to);
      for (const r of chunk.rips) opensRips.push(r);
      for (const t of chunk.momentTemplates) opensTemplates.push(t);
      for (const p of chunk.placeholders) opensPlaceholders.push(p);
    },
  );
  if (opensLoop.errorMsg) {
    errors.push({ cursor: opensCursorId, message: opensLoop.errorMsg });
  }
  const opensTarget = opensLoop.target;
  const opensChunks = opensLoop.chunks;

  // ── opens flush: rip upsert + id lookup + placeholder delete + moments
  let opensActualCursor = opensInitial;
  let ripsInserted = 0;
  let momentsLinked = 0;
  if (opensTarget > opensInitial) {
    try {
      const result = await flushOpens(sb, opensRips, opensTemplates, opensPlaceholders);
      ripsInserted = result.rips_inserted;
      momentsLinked = result.moments_linked;
      // pack_rips_lookup_chunk failures are partial — the surviving chunks
      // still attribute moment_acquisitions correctly, so we surface them
      // through pipeline_runs.extra.errors but advance the cursor normally.
      for (const ce of result.chunk_errors) {
        console.log(`[pack-events-ingest] ${opensCursorId} ${ce.source}: ${ce.message}`);
        errors.push({ cursor: opensCursorId, message: `${ce.source}: ${ce.message}` });
      }
      opensActualCursor = opensTarget;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[pack-events-ingest] ${opensCursorId} flush error: ${msg}`);
      errors.push({ cursor: opensCursorId, message: msg });
    }
  }

  // ── cursor advance: at most 2 writes, run in parallel via allSettled
  const cursorWrites: Array<{ cursor: string; promise: Promise<void> }> = [];
  if (purchasesActualCursor > purchasesInitial) {
    cursorWrites.push({
      cursor: purchasesCursorId,
      promise: writeCursor(sb, purchasesCursorId, purchasesActualCursor),
    });
  }
  if (opensActualCursor > opensInitial) {
    cursorWrites.push({
      cursor: opensCursorId,
      promise: writeCursor(sb, opensCursorId, opensActualCursor),
    });
  }
  if (cursorWrites.length > 0) {
    const results = await Promise.allSettled(cursorWrites.map((w) => w.promise));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.log(`[pack-events-ingest] cursor advance ${cursorWrites[i].cursor} failed: ${msg}`);
        errors.push({ cursor: cursorWrites[i].cursor, message: `cursor advance: ${msg}` });
      }
    }
  }

  const isCaughtUp = (cursor: number) =>
    mode === "live"
      ? cachedSealedTip - cursor <= CAUGHT_UP_THRESHOLD
      : cursor >= TARGET_END_BLOCK;

  const purchasesResult = {
    from_block: purchasesInitial,
    to_block: purchasesActualCursor,
    chunks_processed: purchasesChunks,
    events_processed: purchasesEvents,
    rows_inserted: purchasesRows,
    caught_up: isCaughtUp(purchasesActualCursor),
  };
  const opensResult = {
    from_block: opensInitial,
    to_block: opensActualCursor,
    chunks_processed: opensChunks,
    rips_inserted: ripsInserted,
    moments_linked: momentsLinked,
    caught_up: isCaughtUp(opensActualCursor),
  };

  const durationMs = Date.now() - startedMs;
  await logPipelineRun(sb, {
    pipeline,
    startedAtIso,
    rowsFound: purchasesEvents + ripsInserted,
    rowsWritten: purchasesRows + momentsLinked,
    rowsSkipped: 0,
    ok: errors.length === 0,
    error: errors.length > 0 ? errors.map((e) => `${e.cursor}: ${e.message}`).join(" | ").slice(0, 500) : null,
    cursorBefore: String(purchasesInitial),
    cursorAfter: String(purchasesActualCursor),
    extra: {
      mode,
      sealed_tip: cachedSealedTip,
      duration_ms: durationMs,
      purchases: purchasesResult,
      opens: opensResult,
      purchases_cursor_id: purchasesCursorId,
      opens_cursor_id: opensCursorId,
      target_end_block: mode === "backfill" ? TARGET_END_BLOCK : null,
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    },
  });

  return new Response(
    JSON.stringify({
      ok: errors.length === 0,
      purchases: purchasesResult,
      opens: opensResult,
      sealed_tip: cachedSealedTip,
      duration_ms: durationMs,
      ...(errors.length > 0 ? { errors } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startedMs = Date.now();
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        return healthOk();
      }

      const isLive = request.method === "POST" && url.pathname === "/";
      const isBackfill = request.method === "POST" && url.pathname === "/backfill";
      if (!isLive && !isBackfill) {
        return jsonError(405, "method_or_path_not_allowed", {
          hint:
            "POST / (live) or POST /backfill (historical) with Bearer INGEST_SECRET_TOKEN; GET /health for liveness",
        });
      }

      const auth = request.headers.get("Authorization") ?? "";
      const expected = `Bearer ${env.INGEST_SECRET_TOKEN}`;
      if (!env.INGEST_SECRET_TOKEN || auth !== expected) {
        return jsonError(401, "unauthorized");
      }

      return await runIngest(env, isBackfill ? "backfill" : "live", startedMs);
    } catch (err) {
      // Fatal pre-processing error (auth, sealed-tip fetch, etc.) — still
      // return 200 so cron-job.org keeps retrying without flagging the job.
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[pack-events-ingest] fatal: ${msg}`);
      return new Response(
        JSON.stringify({
          ok: false,
          purchases: zeroPurchases(),
          opens: zeroOpens(),
          sealed_tip: 0,
          duration_ms: Date.now() - startedMs,
          errors: [{ cursor: "pre_processing", message: msg }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
  },
};
