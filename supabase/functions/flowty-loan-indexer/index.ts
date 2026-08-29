// flowty-loan-indexer v3 — writes to flowty_loan_events only, then calls rebuild_flowty_loans(listing_ids[])
// SQL function handles the lifecycle synthesis correctly across event types.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const INGEST_SECRET        = Deno.env.get("INGEST_SECRET_TOKEN");
const SUPABASE_URL         = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const CURRENT_ACCESS    = "https://rest-mainnet.onflow.org";
const CHECKPOINT_KEY    = "flowty_loans_indexer";
const FLOOR_BLOCK       = 137_400_000;

const EVENT_TYPES = [
  "A.5c57f79c6694797f.Flowty.ListingAvailable",
  "A.5c57f79c6694797f.Flowty.ListingCompleted",
  "A.5c57f79c6694797f.Flowty.FundingAvailable",
  "A.5c57f79c6694797f.Flowty.FundingRepaid",
  "A.5c57f79c6694797f.Flowty.FundingSettled",
] as const;

const EVENT_KIND: Record<string, string> = {
  ListingAvailable:  "LISTING_AVAILABLE",
  ListingCompleted:  "LISTING_COMPLETED",
  FundingAvailable:  "FUNDING_AVAILABLE",
  FundingRepaid:     "FUNDING_REPAID",
  FundingSettled:    "FUNDING_SETTLED",
};

const CHUNK_SIZE         = 249;
const DEFAULT_MAX_CHUNKS = 30;
const REST_TIMEOUT_MS    = 10_000;
const INTER_CHUNK_PAUSE  = 50;

function nftTypeToCollection(t: string): string {
  if (t.includes("TopShot.NFT"))  return "topshot";
  if (t.includes("AllDay.NFT"))   return "allday";
  if (t.includes("Golazos.NFT"))  return "golazos";
  if (t.includes("Pinnacle.NFT")) return "pinnacle";
  if (t.includes("UFC_NFT.NFT")) return "ufc";
  return "other";
}

function fields(payload: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of (payload?.value?.fields ?? [])) out[f.name] = f.value;
  return out;
}
function asString(v: any): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v?.value === "string") return v.value;
  return null;
}
function asUInt(v: any): number | null {
  const s = asString(v); if (s == null) return null;
  const n = Number(s); return Number.isFinite(n) ? n : null;
}
function asUFix(v: any): string | null { return asString(v); }
function asBool(v: any): boolean | null {
  if (v?.value === true || v?.value === "true") return true;
  if (v?.value === false || v?.value === "false") return false;
  if (typeof v === "boolean") return v;
  return null;
}
function asOptionalAddress(v: any): string | null {
  if (!v) return null;
  if (v.value === null || v.value === undefined) return null;
  if (typeof v.value === "string") return v.value;
  if (typeof v.value?.value === "string") return v.value.value;
  return null;
}

async function fetchEvents(eventType: string, startHeight: number, endHeight: number): Promise<any[]> {
  const url = `${CURRENT_ACCESS}/v1/events?type=${encodeURIComponent(eventType)}&start_height=${startHeight}&end_height=${endHeight}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(REST_TIMEOUT_MS) });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

async function getChainTip(): Promise<number | null> {
  try {
    const r = await fetch(`${CURRENT_ACCESS}/v1/blocks?height=sealed`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const blocks = await r.json();
    return parseInt(blocks?.[0]?.header?.height ?? "0") || null;
  } catch { return null; }
}

async function getBlockTs(blockHeight: number): Promise<string | null> {
  try {
    const r = await fetch(`${CURRENT_ACCESS}/v1/blocks?height=${blockHeight}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const blocks = await r.json();
    return blocks?.[0]?.header?.timestamp ?? null;
  } catch { return null; }
}

function buildRow(event: any, blockHeight: number, occurredAt: string): any | null {
  let payload;
  try { payload = JSON.parse(atob(event.payload)); } catch { return null; }
  if (!payload) return null;

  const fullName = String(event.type ?? "");
  const shortName = fullName.split(".").pop() ?? "";
  const event_type = EVENT_KIND[shortName];
  if (!event_type) return null;

  const f = fields(payload);
  const nftTypeStr = asString(f.nftType);
  const termFix = asUFix(f.term);
  const expFix  = asUFix(f.expiresAfter);

  return {
    tx_hash: event.transaction_id,
    event_index: parseInt(event.event_index ?? event.transaction_index ?? "0"),
    block_height: blockHeight,
    occurred_at: occurredAt,
    event_type,
    listing_resource_id: asUInt(f.listingResourceID),
    funding_resource_id: asUInt(f.fundingResourceID),
    storefront_address: asString(f.flowtyStorefrontAddress),
    storefront_id: asUInt(f.flowtyStorefrontID),
    borrower_addr: asString(f.borrower),
    lender_addr: asString(f.lender),
    repayment_addr: asOptionalAddress(f.repaymentAddress),
    nft_type: nftTypeStr,
    nft_id: asUInt(f.nftID),
    collection: nftTypeStr ? nftTypeToCollection(nftTypeStr) : null,
    amount: asUFix(f.amount),
    interest_rate: asUFix(f.interestRate),
    term_seconds: termFix ? Math.round(parseFloat(termFix)) : null,
    expires_after_secs: expFix ? Math.round(parseFloat(expFix)) : null,
    royalty_rate: asUFix(f.royaltyRate),
    payment_token_type: asString(f.paymentTokenType),
    repayment_amount: asUFix(f.repaymentAmount),
    auto_repayment: asBool(f.enabledAutoRepayment),
    funded: asBool(f.funded),
    payload,
  };
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${INGEST_SECRET}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as any;
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);

  let startHeight: number = body.start_height ?? 0;
  if (!startHeight) {
    const { data } = await supabase.from("scan_checkpoint").select("block_height").eq("key", CHECKPOINT_KEY).maybeSingle();
    startHeight = data?.block_height ?? FLOOR_BLOCK;
  }
  if (startHeight < FLOOR_BLOCK) startHeight = FLOOR_BLOCK;

  let endHeight: number = body.end_height ?? 0;
  if (!endHeight) {
    const tip = await getChainTip();
    if (!tip) return new Response(JSON.stringify({ error: "Could not determine chain tip" }), { status: 500 });
    endHeight = tip - 50;
  }
  if (startHeight >= endHeight) {
    return new Response(JSON.stringify({ ok: true, message: "At chain tip", block_height: startHeight, done: true }));
  }

  const maxChunks: number = Math.max(1, Math.min(120, body.max_chunks ?? DEFAULT_MAX_CHUNKS));

  let chunksProcessed = 0;
  let totalEventsDecoded = 0;
  let totalEventsInserted = 0;
  let totalLoansRebuilt = 0;
  let cursor = startHeight;

  while (cursor <= endHeight && chunksProcessed < maxChunks) {
    const chunkEnd = Math.min(cursor + CHUNK_SIZE - 1, endHeight);
    const chunkRows: any[] = [];
    const touchedListings = new Set<number>();

    // Sequential event-type fetches
    for (const eventType of EVENT_TYPES) {
      const blocks = await fetchEvents(eventType, cursor, chunkEnd);
      if (blocks.length === 0) continue;

      for (const blk of blocks) {
        const blockHeight = parseInt(blk.block_height ?? "0") || cursor;
        let ts: string | null = null;
        if ((blk.events ?? []).length > 0) {
          ts = await getBlockTs(blockHeight);
          if (!ts) continue;
        }
        for (const ev of (blk.events ?? [])) {
          const row = buildRow(ev, blockHeight, ts!);
          if (row) {
            chunkRows.push(row);
            if (row.listing_resource_id != null) touchedListings.add(row.listing_resource_id);
          }
        }
      }
    }

    totalEventsDecoded += chunkRows.length;

    // Insert raw events (idempotent)
    if (chunkRows.length > 0) {
      const { error, count } = await supabase
        .from("flowty_loan_events")
        .upsert(chunkRows, { onConflict: "tx_hash,event_index", ignoreDuplicates: true, count: "exact" });
      if (!error && count) totalEventsInserted += count;
      else if (error) console.log("[idx] event insert err:", error.message);

      // Trigger SQL-side rebuild for the listings touched in this chunk
      if (touchedListings.size > 0) {
        const ids = Array.from(touchedListings);
        const { data, error: rpcErr } = await supabase.rpc("rebuild_flowty_loans", { listing_ids: ids });
        if (!rpcErr && typeof data === "number") totalLoansRebuilt += data;
        else if (rpcErr) console.log("[idx] rebuild err:", rpcErr.message);
      }
    }

    cursor = chunkEnd + 1;
    chunksProcessed++;

    if (chunksProcessed % 5 === 0 || chunksProcessed === maxChunks) {
      await supabase.from("scan_checkpoint").upsert({
        key: CHECKPOINT_KEY, block_height: cursor - 1, updated_at: new Date().toISOString()
      });
    }

    await new Promise(r => setTimeout(r, INTER_CHUNK_PAUSE));
  }

  const scannedThrough = cursor - 1;
  await supabase.from("scan_checkpoint").upsert({
    key: CHECKPOINT_KEY, block_height: scannedThrough, updated_at: new Date().toISOString()
  });

  const progressPct = Math.round(((scannedThrough - FLOOR_BLOCK) / (endHeight - FLOOR_BLOCK)) * 100);

  return new Response(JSON.stringify({
    ok: true,
    chunks_processed: chunksProcessed,
    events_decoded: totalEventsDecoded,
    events_inserted: totalEventsInserted,
    loans_rebuilt: totalLoansRebuilt,
    scanned_from: startHeight,
    scanned_through: scannedThrough,
    chain_tip: endHeight,
    progress_pct: progressPct,
    done: scannedThrough >= endHeight,
  }), { headers: { "Content-Type": "application/json" } });
});
