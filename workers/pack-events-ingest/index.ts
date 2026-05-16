// workers/pack-events-ingest/index.ts
//
// Top Shot pack lifecycle classifier — runs on a */15 cron, advances two
// cursors stored in event_cursor (topshot_pack_purchases + topshot_pack_opens),
// indexes secondary-market pack purchases and pack opens, and backfills
// moment_acquisitions with verified pack_rip provenance (replacing the
// 'cache-refresh:%' placeholders left by earlier wallet-walk ingest).
//
// Auth:    POST /         Bearer INGEST_SECRET_TOKEN
// Health:  GET  /health   unauthenticated; returns {ok: true}
//
// Response shape (always 200, even on per-cursor failure so cron retries
// cleanly):
//   {
//     ok: boolean,                      // false iff one or both cursors errored
//     purchases: { from_block, to_block, events_processed, rows_inserted },
//     opens:     { from_block, to_block, rips_inserted, moments_linked },
//     errors?:   [{ cursor, message }],
//     duration_ms: number
//   }
//
// Per-tick chunk = 250 blocks per cursor (matches Flow REST /v1/events
// page limit). Cursor advances ONLY after every write in the chunk
// succeeds; an exception inside a cursor's block leaves the cursor in
// place so the next cron tick re-attempts the same range.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

interface Env {
  INGEST_SECRET_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const FLOW_REST = "https://rest-mainnet.onflow.org";
const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"; // Top Shot
const CHUNK_SIZE = 250;
const REQUEST_TIMEOUT_MS = 20_000;

const CURSOR_PURCHASES = "topshot_pack_purchases";
const CURSOR_OPENS = "topshot_pack_opens";

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
      cursors: [CURSOR_PURCHASES, CURSOR_OPENS],
      chunk_size: CHUNK_SIZE,
      collection_id: COLLECTION_ID,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
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
// Cursor read / write
// ─────────────────────────────────────────────────────────────────────────────

async function readCursor(sb: SupabaseClient, id: string): Promise<number> {
  const { data, error } = await sb
    .from("event_cursor")
    .select("last_processed_block")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`event_cursor read ${id}: ${error.message}`);
  if (!data) throw new Error(`event_cursor row missing for id=${id} — seed it before deploying`);
  return Number((data as { last_processed_block: number }).last_processed_block);
}

async function writeCursor(sb: SupabaseClient, id: string, height: number): Promise<void> {
  const { error } = await sb
    .from("event_cursor")
    .upsert({ id, last_processed_block: height, updated_at: new Date().toISOString() });
  if (error) throw new Error(`event_cursor write ${id} -> ${height}: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor 1: topshot_pack_purchases
// ─────────────────────────────────────────────────────────────────────────────

interface PurchasesResult {
  from_block: number;
  to_block: number;
  events_processed: number;
  rows_inserted: number;
}

async function processPurchases(
  sb: SupabaseClient,
  fromBlock: number,
  toBlock: number,
): Promise<PurchasesResult> {
  if (fromBlock > toBlock) {
    return { from_block: fromBlock, to_block: toBlock, events_processed: 0, rows_inserted: 0 };
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

  const rows: Array<Record<string, unknown>> = [];
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

  let rowsInserted = 0;
  if (rows.length > 0) {
    // Chunk to keep request bodies bounded.
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const { data, error } = await sb
        .from("pack_purchases")
        .upsert(batch, { onConflict: "tx_hash,listing_resource_id", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`pack_purchases upsert chunk=${i}: ${error.message}`);
      rowsInserted += data?.length ?? 0;
    }
  }

  return {
    from_block: fromBlock,
    to_block: toBlock,
    events_processed: eventsProcessed,
    rows_inserted: rowsInserted,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor 2: topshot_pack_opens
// ─────────────────────────────────────────────────────────────────────────────

interface OpensResult {
  from_block: number;
  to_block: number;
  rips_inserted: number;
  moments_linked: number;
}

async function processOpens(
  sb: SupabaseClient,
  fromBlock: number,
  toBlock: number,
): Promise<OpensResult> {
  if (fromBlock > toBlock) {
    return { from_block: fromBlock, to_block: toBlock, rips_inserted: 0, moments_linked: 0 };
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

  let ripsInserted = 0;
  let momentsLinked = 0;

  for (const opened of openedEvents) {
    const txDeposits = depositsByTx.get(opened.transaction_id) ?? [];
    if (txDeposits.length === 0) continue; // pack opened with no minted moments — skip

    const opener = txDeposits[0].decoded["to"];
    if (typeof opener !== "string") continue;

    const packNftId = opened.decoded["id"];
    if (packNftId === undefined || packNftId === null) continue;

    const ripRow = {
      collection_id: COLLECTION_ID,
      pack_nft_id: String(packNftId),
      opener_address: opener,
      moments_pulled: txDeposits.length,
      total_fmv_at_rip: null,
      tx_hash: opened.transaction_id,
      block_height: opened.block_height,
      sealed_at: opened.block_timestamp,
    };

    const { data: ripData, error: ripErr } = await sb
      .from("pack_rips")
      .upsert([ripRow], { onConflict: "tx_hash", ignoreDuplicates: true })
      .select("id");
    if (ripErr) throw new Error(`pack_rips upsert tx=${opened.transaction_id}: ${ripErr.message}`);

    let packRipId: string;
    if (ripData && ripData.length > 0) {
      packRipId = (ripData[0] as { id: string }).id;
      ripsInserted++;
    } else {
      const { data: existing, error: selErr } = await sb
        .from("pack_rips")
        .select("id")
        .eq("tx_hash", opened.transaction_id)
        .maybeSingle();
      if (selErr || !existing) {
        throw new Error(
          `pack_rips conflict-skip but no existing row for tx=${opened.transaction_id}: ${selErr?.message ?? "missing"}`,
        );
      }
      packRipId = (existing as { id: string }).id;
    }

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

      // Drop any synthetic placeholder row first so the verified row is
      // the only provenance for this (nft_id, wallet) pair.
      const { error: delErr } = await sb
        .from("moment_acquisitions")
        .delete()
        .eq("nft_id", nftIdStr)
        .eq("wallet", opener)
        .like("transaction_hash", "cache-refresh:%");
      if (delErr) {
        throw new Error(
          `moment_acquisitions delete-placeholder nft=${nftIdStr} wallet=${opener}: ${delErr.message}`,
        );
      }

      const { data: insData, error: insErr } = await sb
        .from("moment_acquisitions")
        .upsert(
          [
            {
              nft_id: nftIdStr,
              collection_id: COLLECTION_ID,
              wallet: opener,
              acquisition_method: "pack_rip",
              acquisition_confidence: "verified",
              acquired_date: opened.block_timestamp,
              transaction_hash: opened.transaction_id,
              source_address: sourceAddress,
              source_pack_rip_id: packRipId,
            },
          ],
          { onConflict: "nft_id,wallet,transaction_hash", ignoreDuplicates: true },
        )
        .select("id");
      if (insErr) {
        throw new Error(
          `moment_acquisitions insert nft=${nftIdStr} wallet=${opener}: ${insErr.message}`,
        );
      }
      if (insData && insData.length > 0) momentsLinked++;
    }
  }

  return {
    from_block: fromBlock,
    to_block: toBlock,
    rips_inserted: ripsInserted,
    moments_linked: momentsLinked,
  };
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
      if (request.method !== "POST" || url.pathname !== "/") {
        return jsonError(405, "method_or_path_not_allowed", {
          hint: "POST / with Bearer INGEST_SECRET_TOKEN; GET /health for liveness",
        });
      }

      const auth = request.headers.get("Authorization") ?? "";
      const expected = `Bearer ${env.INGEST_SECRET_TOKEN}`;
      if (!env.INGEST_SECRET_TOKEN || auth !== expected) {
        return jsonError(401, "unauthorized");
      }
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        return jsonError(500, "supabase_env_missing", {
          hint: "wrangler secret put SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY",
        });
      }

      const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const sealedTip = await getSealedHeight();

      const errors: Array<{ cursor: string; message: string }> = [];

      // ── purchases ───────────────────────────────────────────────────────
      let purchasesResult: PurchasesResult = {
        from_block: 0,
        to_block: 0,
        events_processed: 0,
        rows_inserted: 0,
      };
      try {
        const purchasesCursor = await readCursor(sb, CURSOR_PURCHASES);
        const pFrom = purchasesCursor + 1;
        const pTo = Math.min(purchasesCursor + CHUNK_SIZE, sealedTip);
        purchasesResult = await processPurchases(sb, pFrom, pTo);
        if (pTo >= pFrom) await writeCursor(sb, CURSOR_PURCHASES, pTo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[pack-events-ingest] ${CURSOR_PURCHASES} error: ${msg}`);
        errors.push({ cursor: CURSOR_PURCHASES, message: msg });
      }

      // ── opens ───────────────────────────────────────────────────────────
      let opensResult: OpensResult = {
        from_block: 0,
        to_block: 0,
        rips_inserted: 0,
        moments_linked: 0,
      };
      try {
        const opensCursor = await readCursor(sb, CURSOR_OPENS);
        const oFrom = opensCursor + 1;
        const oTo = Math.min(opensCursor + CHUNK_SIZE, sealedTip);
        opensResult = await processOpens(sb, oFrom, oTo);
        if (oTo >= oFrom) await writeCursor(sb, CURSOR_OPENS, oTo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[pack-events-ingest] ${CURSOR_OPENS} error: ${msg}`);
        errors.push({ cursor: CURSOR_OPENS, message: msg });
      }

      return new Response(
        JSON.stringify({
          ok: errors.length === 0,
          purchases: purchasesResult,
          opens: opensResult,
          ...(errors.length > 0 ? { errors } : {}),
          sealed_tip: sealedTip,
          duration_ms: Date.now() - startedMs,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      // Fatal pre-processing error (auth, sealed-tip fetch, etc.) — still
      // return 200 so cron-job.org keeps retrying without flagging the job.
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[pack-events-ingest] fatal: ${msg}`);
      return new Response(
        JSON.stringify({
          ok: false,
          purchases: { from_block: 0, to_block: 0, events_processed: 0, rows_inserted: 0 },
          opens: { from_block: 0, to_block: 0, rips_inserted: 0, moments_linked: 0 },
          errors: [{ cursor: "pre_processing", message: msg }],
          duration_ms: Date.now() - startedMs,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
  },
};
