#!/usr/bin/env node
// scripts/backfill-pinnacle-editions.ts
//
// One-off backfill that resolves Pinnacle nft_id → edition_id for sales that
// landed in pinnacle_sales with edition_id = NULL.
//
// Why not the Cadence-borrow path: pinnacle_sales.buyer_address stores the
// NFTStorefrontV2 commissionReceiver, which for Pinnacle trades is the
// Pinnacle contract itself (0xedf9df96c92f4595) rather than the real buyer.
// Without an owner address we can't borrow the NFT. Instead we scan the
// contract's own PinNFTMinted events — those emit `id` (nft_id) and
// `editionID` directly, so one index pass builds a complete nft_id → edition
// map.
//
// Strategy:
//   1. Read the set of unresolved nft_ids from pinnacle_sales_needing_lookup.
//   2. Scan A.edf9df96c92f4595.Pinnacle.PinNFTMinted events via Flow REST,
//      walking forward from a configurable start block in 249-block chunks.
//      Progress persists to backfill_state (id='pinnacle_mint_scan') so
//      subsequent runs resume where the last one stopped.
//   3. For every mint event seen, upsert (nft_id, edition_key) into
//      pinnacle_nft_map ON CONFLICT DO NOTHING.
//   4. Periodically re-check how many target nft_ids remain unresolved.
//      When the working set is empty OR the cursor reaches the sealed head,
//      stop and call backfill_pinnacle_sale_editions() to promote the
//      now-resolvable sales rows.
//
// Idempotent — safe to re-run (state cursor + upsert ON CONFLICT).
//
// Usage:   npx tsx scripts/backfill-pinnacle-editions.ts
// Env:     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (required)
//          PINNACLE_START_BLOCK  (default: resume from backfill_state, else 85_000_000)
//          PINNACLE_MAX_BLOCKS   (hard cap per run, default 5_000_000)
//          PINNACLE_CHECK_EVERY  (re-check unmapped set every N chunks, default 500)

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const FLOW_REST = "https://rest-mainnet.onflow.org";
const MINT_EVENT = "A.edf9df96c92f4595.Pinnacle.PinNFTMinted";
const CHUNK_SIZE = 249;
const DEFAULT_START = 85_000_000;
const MAX_BLOCKS = Number(process.env.PINNACLE_MAX_BLOCKS ?? 5_000_000);
const CHECK_EVERY = Number(process.env.PINNACLE_CHECK_EVERY ?? 500);
const STATE_ID = "pinnacle_mint_scan";

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set (use .env or export)");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

interface FlowEventBlock {
  block_height: string;
  events?: Array<{ type: string; transaction_id: string; payload: string }>;
}

async function fetchEventRange(start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(MINT_EVENT)}&start_height=${start}&end_height=${end}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    console.log(`[pinnacle-backfill] events ${start}-${end} HTTP ${res.status}`);
    return [];
  }
  const json = (await res.json()) as FlowEventBlock[];
  return Array.isArray(json) ? json : [];
}

async function getSealedHeight(): Promise<number> {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`);
  const json = (await res.json()) as Array<{ header: { height: string } }>;
  return Number(json[0]?.header?.height ?? 0);
}

interface EventField {
  name: string;
  value: { type: string; value: unknown };
}

function extractMint(raw: unknown): { nftId: string; editionID: string } | null {
  const envelope = raw as { value?: { fields?: EventField[] } };
  const fields = envelope?.value?.fields;
  if (!Array.isArray(fields)) return null;
  let nftId: string | null = null;
  let editionID: string | null = null;
  for (const f of fields) {
    if (f.name === "id") nftId = String(f.value?.value ?? "");
    else if (f.name === "editionID") editionID = String(f.value?.value ?? "");
  }
  if (!nftId || !editionID) return null;
  return { nftId, editionID };
}

async function loadCursor(): Promise<number> {
  const override = process.env.PINNACLE_START_BLOCK;
  if (override) return Number(override);
  const { data } = await supabase
    .from("backfill_state")
    .select("cursor")
    .eq("id", STATE_ID)
    .maybeSingle();
  return data?.cursor ? parseInt(String(data.cursor)) : DEFAULT_START;
}

async function saveCursor(cursor: number, totalMinted: number, status: string, notes: string | null) {
  const { error } = await supabase.from("backfill_state").upsert({
    id: STATE_ID,
    cursor: String(cursor),
    total_ingested: totalMinted,
    last_run_at: new Date().toISOString(),
    status,
    notes,
  });
  if (error) console.log(`[pinnacle-backfill] saveCursor err: ${error.message}`);
}

async function loadTargetNftIds(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("pinnacle_sales_needing_lookup")
    .select("nft_id");
  if (error) throw new Error(`pinnacle_sales_needing_lookup: ${error.message}`);
  return new Set((data ?? []).map((r: { nft_id: string }) => r.nft_id));
}

async function flushMapRows(rows: Array<{ nft_id: string; edition_key: string }>): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await supabase
    .from("pinnacle_nft_map")
    .upsert(rows, { onConflict: "nft_id", ignoreDuplicates: true });
  if (error) {
    console.log(`[pinnacle-backfill] upsert err: ${error.message}`);
    return 0;
  }
  return rows.length;
}

async function main() {
  console.log(`[pinnacle-backfill] starting max_blocks=${MAX_BLOCKS} chunk=${CHUNK_SIZE}`);

  const initialTargets = await loadTargetNftIds();
  const remaining = new Set(initialTargets);
  console.log(`[pinnacle-backfill] ${remaining.size} nft_ids need edition lookup`);
  if (remaining.size === 0) {
    console.log("nothing to do.");
    return;
  }

  const startCursor = await loadCursor();
  const sealed = await getSealedHeight();
  const endCursor = Math.min(startCursor + MAX_BLOCKS, sealed);
  console.log(`[pinnacle-backfill] scanning blocks ${startCursor} → ${endCursor} (sealed=${sealed})`);

  let cursor = startCursor;
  let mintedSeen = 0;
  let resolvedInRun = 0;
  let flushed = 0;
  let chunks = 0;
  const pending: Array<{ nft_id: string; edition_key: string }> = [];

  while (cursor <= endCursor) {
    const start = cursor;
    const end = Math.min(cursor + CHUNK_SIZE, endCursor);

    const blocks = await fetchEventRange(start, end);
    for (const blk of blocks) {
      for (const evt of blk.events ?? []) {
        mintedSeen++;
        try {
          const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"));
          const mint = extractMint(raw);
          if (!mint) continue;
          pending.push({ nft_id: mint.nftId, edition_key: mint.editionID });
          if (remaining.has(mint.nftId)) {
            remaining.delete(mint.nftId);
            resolvedInRun++;
          }
        } catch (e) {
          console.log(`[pinnacle-backfill] decode err: ${(e as Error).message}`);
        }
      }
    }

    cursor = end + 1;
    chunks++;

    if (pending.length >= 500) {
      flushed += await flushMapRows(pending.splice(0, pending.length));
    }

    if (chunks % CHECK_EVERY === 0) {
      // Periodically flush + persist cursor + report.
      flushed += await flushMapRows(pending.splice(0, pending.length));
      await saveCursor(cursor, flushed, "running", `resolved=${resolvedInRun} remaining=${remaining.size}`);
      console.log(
        `[pinnacle-backfill] block=${cursor} minted_seen=${mintedSeen} resolved_in_run=${resolvedInRun} still_unmapped=${remaining.size} flushed=${flushed}`
      );
      if (remaining.size === 0) {
        console.log(`[pinnacle-backfill] all target nft_ids resolved at cursor=${cursor}`);
        break;
      }
    }
  }

  flushed += await flushMapRows(pending.splice(0, pending.length));
  const status = remaining.size === 0 ? "completed" : cursor > endCursor ? "paused_at_cap" : "running";
  await saveCursor(cursor, flushed, status, `resolved=${resolvedInRun} remaining=${remaining.size}`);

  console.log(`[pinnacle-backfill] calling backfill_pinnacle_sale_editions()...`);
  const { data: promoted, error: promoteErr } = await supabase.rpc("backfill_pinnacle_sale_editions");
  if (promoteErr) console.log(`[pinnacle-backfill] promote err: ${promoteErr.message}`);
  else console.log(`[pinnacle-backfill] promote returned: ${JSON.stringify(promoted)}`);

  console.log(
    `\n[pinnacle-backfill] done: queried=${initialTargets.size} resolved_in_run=${resolvedInRun} still_unmapped=${remaining.size} mints_seen=${mintedSeen} cursor_end=${cursor} status=${status}`
  );
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
