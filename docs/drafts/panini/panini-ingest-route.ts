// app/api/cron/panini-ingest/route.ts  (DRAFT / not in the live tree)
//
// PUSH ingest for Panini Plane-A: receives batches captured by the residential runner
// (docs/drafts/panini/ingest-panini-runner.mjs) and writes panini_editions /
// panini_pack_state / panini_fmv_snapshots. The runner does all auth + signing in a
// real logged-in browser; this route only normalizes + upserts (service-role).
//
// Body shape (all optional arrays):
//   { cards:   [ getCardMarketStats.data, ... ],
//     packs:   [ getPackMarketStats.data, ... ],
//     serials: [ getPskuTotalCardsList ...products, ... ] }   // serials -> panini_card_serials (special-serial layer)
//
// INERT-safe: empty body → logged no-op. Apply panini-schema.sql first.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PANINI_UUID = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b";
const PIPELINE = "panini-ingest";
const CHUNK = 500;

const TIER: Record<string, string> = { Uncommon: "COMMON", Rare: "RARE", "Ultra Rare": "RARE", Epic: "LEGENDARY", Legendary: "ULTIMATE" };
const FOTL = /aguila|maple leaf|old glory|nebula/i;

function parallelFamily(cardset = ""): string {
  if (FOTL.test(cardset)) return "fotl_exclusive";
  if (/^base/i.test(cardset)) return "base";
  if (/silver|gold|black/i.test(cardset)) return "tiered_insert";
  return "non_tiered_insert";
}

// getCardMarketStats.data -> panini_editions row. unopened_pack_count is the AUTHORITATIVE
// still_in_packs (stored, not derived); pulled = with_collectors_count.
function toEditionRow(c: any, nowIso: string) {
  const ms = c?.market_stats ?? {};
  const cap = Number(c?.end_seq) || null;
  return {
    id: String(c?.sku ?? c?.psku),
    external_id: String(c?.psku ?? c?.sku),
    collection_id: PANINI_UUID,
    player_name: c?.athlete ?? null,
    set_name: c?.cardset ?? null,
    parallel: c?.cardset ?? null,
    parallel_family: parallelFamily(c?.cardset ?? ""),
    rarity_label: c?.card_rarity ?? c?.rarity ?? null,
    tier: TIER[c?.card_rarity ?? c?.rarity ?? ""] ?? null,
    mint_cap: cap,
    pulled_count: Number.isFinite(+ms.with_collectors_count) ? +ms.with_collectors_count : 0,
    still_in_packs: Number.isFinite(+ms.unopened_pack_count) ? +ms.unopened_pack_count : 0,
    for_sale_count: Number.isFinite(+ms.for_sale_count) ? +ms.for_sale_count : 0,
    burned_count: Number.isFinite(+ms.burned_count) ? +ms.burned_count : 0,
    is_fotl_exclusive: FOTL.test(c?.cardset ?? ""),
    serial_low_ask_usd: Number.isFinite(+ms.floor_price) ? +ms.floor_price : null,
    thumbnail_url: c?.image_thumbnail ?? null,
    video_url: c?.image_url ?? null,
    last_seen_at: nowIso,
  };
}

// A simple FMV snapshot from the market_stats (sales-first, ASK_ONLY floor fallback).
// The fuller panini-1.0.0 model (serial-aware) lands in panini-fmv-recalc later.
function toFmvRow(c: any, nowIso: string) {
  const ms = c?.market_stats ?? {};
  const txns = Number(ms.volume_txns) || 0;
  let fmv: number | null = null, confidence = "NO_DATA";
  if (txns > 0 && Number.isFinite(+ms.recent_sale)) { fmv = +ms.avg_sale || +ms.recent_sale; confidence = txns >= 3 ? "HIGH" : txns === 2 ? "MEDIUM" : "LOW"; }
  else if (Number.isFinite(+ms.floor_price) && +ms.floor_price > 0) { fmv = Math.round(+ms.floor_price * 0.9); confidence = "ASK_ONLY"; }
  if (fmv == null) return null;
  return { edition_id: String(c?.sku ?? c?.psku), fmv_usd: fmv, confidence, algo_version: "panini-1.0.0", computed_at: nowIso };
}

// getPskuTotalCardsList product -> panini_card_serials row. The per-serial sku is
// '<psku>__<serial>_<cap>' (the psku itself contains single underscores, so the
// double underscore is the delimiter). nft_type ('number 1' / 'jersey mint,perfect
// mint' / null) is comma-separated -> the three special-serial flags.
function toSerialRow(s: any, nowIso: string) {
  const sku = s?.sku != null ? String(s.sku) : "";
  if (!sku) return null;
  const sep = sku.indexOf("__");
  const editionExternalId = sep >= 0 ? sku.slice(0, sep) : null;
  const tail = sep >= 0 ? sku.slice(sep + 2) : "";
  const [serialStr, capStr] = tail.split("_");
  const serialNumber = Number.isFinite(+serialStr) ? +serialStr : Number.isFinite(+s?.start_seq) ? +s.start_seq : null;
  const mintCap = Number.isFinite(+capStr) ? +capStr : Number.isFinite(+s?.end_seq) ? +s.end_seq : null;
  const types = String(s?.nft_type ?? "")
    .toLowerCase()
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    sku,
    edition_external_id: editionExternalId,
    collection_id: PANINI_UUID,
    serial_number: serialNumber,
    mint_cap: mintCap,
    buy_now_price_usd: Number.isFinite(+s?.buy_now_price) ? +s.buy_now_price : null,
    current_bid_usd: Number.isFinite(+s?.current_bid) ? +s.current_bid : null,
    owner_username: s?.owner ?? null,
    bought_at_price_usd: Number.isFinite(+s?.brought_at_price) ? +s.brought_at_price : null,
    bought_at_time: s?.brought_at_time ?? null,
    burned_count: Number.isFinite(+s?.burned_count) ? +s.burned_count : 0,
    is_burnable: s?.is_burnable === true,
    nft_type: s?.nft_type ?? null,
    is_number_one: types.includes("number 1"),
    is_jersey_mint: types.includes("jersey mint"),
    is_perfect_mint: types.includes("perfect mint"),
    last_seen_at: nowIso,
  };
}

function toPackRow(p: any, nowIso: string) {
  const ms = p?.market_stats ?? {};
  return {
    id: String(p?.pack_sku ?? p?.collection_name),
    collection_id: PANINI_UUID,
    pack_type: /fotl|first off/i.test(p?.pack_name ?? "") ? "fotl" : "hobby",
    price_usd: null,
    cards_per_pack: Number(p?.cards_per_subpack) || null,
    packs_total: Number(p?.total_pack_qty) || null,
    packs_remaining: Number.isFinite(+ms.unopen_pack_count) ? +ms.unopen_pack_count : null,
    gross_ev_usd: null,
    net_ev_usd: null,
    updated_at: nowIso,
  };
}

async function logRun(startedAtIso: string, found: number, written: number, ok: boolean, error: string | null, extra: any) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE, p_started_at: startedAtIso, p_rows_found: found, p_rows_written: written, p_rows_skipped: 0,
      p_ok: ok, p_error: error, p_collection_slug: "panini_blockchain", p_cursor_before: null, p_cursor_after: null, p_extra: extra,
    });
  } catch (e) { console.log(`[${PIPELINE}] log failed: ${e instanceof Error ? e.message : String(e)}`); }
}

export async function POST(req: NextRequest) {
  const expected = process.env.INGEST_SECRET_TOKEN;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const startedAtIso = new Date().toISOString();
  let body: any = {};
  try { body = await req.json(); } catch {}
  const cards: any[] = Array.isArray(body.cards) ? body.cards : [];
  const packs: any[] = Array.isArray(body.packs) ? body.packs : [];
  const serials: any[] = Array.isArray(body.serials) ? body.serials : [];
  const found = cards.length + packs.length + serials.length;
  if (!found) { await logRun(startedAtIso, 0, 0, true, null, { skip: "empty" }); return NextResponse.json({ accepted: false, skipped: "empty" }, { status: 202 }); }

  after(async () => {
    let written = 0;
    let serialsWritten = 0;
    try {
      const nowIso = new Date().toISOString();
      // editions (dedup by external_id within the batch)
      const byKey = new Map<string, any>();
      for (const c of cards) { const r = toEditionRow(c, nowIso); if (r.external_id) byKey.set(r.external_id, r); }
      const editionRows = [...byKey.values()];
      for (let i = 0; i < editionRows.length; i += CHUNK) {
        const { data, error } = await (supabaseAdmin as any).from("panini_editions").upsert(editionRows.slice(i, i + CHUNK), { onConflict: "external_id,collection_id" }).select("id");
        if (error) console.log(`[${PIPELINE}] editions upsert: ${error.message}`); else written += data?.length ?? 0;
      }
      // fmv snapshots (delete-then-insert per edition; daily history intentional)
      const fmvRows = cards.map((c) => toFmvRow(c, nowIso)).filter(Boolean) as any[];
      if (fmvRows.length) {
        const ids = [...new Set(fmvRows.map((f) => f.edition_id))];
        for (let i = 0; i < ids.length; i += CHUNK) await (supabaseAdmin as any).from("panini_fmv_snapshots").delete().in("edition_id", ids.slice(i, i + CHUNK)).gte("computed_at", nowIso.slice(0, 10));
        for (let i = 0; i < fmvRows.length; i += CHUNK) await (supabaseAdmin as any).from("panini_fmv_snapshots").insert(fmvRows.slice(i, i + CHUNK));
      }
      // pack state
      if (packs.length) {
        const packRows = packs.map((p) => toPackRow(p, nowIso));
        await (supabaseAdmin as any).from("panini_pack_state").upsert(packRows, { onConflict: "id" });
      }
      // serials -> panini_card_serials (per-serial listings + special-serial layer).
      // Dedup by sku within the batch; upsert on the sku PK. See panini-schema.sql §4.
      if (serials.length) {
        const bySku = new Map<string, any>();
        for (const s of serials) { const r = toSerialRow(s, nowIso); if (r) bySku.set(r.sku, r); }
        const serialRows = [...bySku.values()];
        for (let i = 0; i < serialRows.length; i += CHUNK) {
          const chunk = serialRows.slice(i, i + CHUNK);
          const { error } = await (supabaseAdmin as any).from("panini_card_serials").upsert(chunk, { onConflict: "sku" });
          if (error) console.log(`[${PIPELINE}] serials upsert: ${error.message}`); else serialsWritten += chunk.length;
        }
      }
      await logRun(startedAtIso, found, written + serialsWritten, true, null, { editions: written, fmv: fmvRows.length, packs: packs.length, serials: serialsWritten });
    } catch (e) {
      await logRun(startedAtIso, found, written, false, e instanceof Error ? e.message : String(e), {});
    }
  });
  return NextResponse.json({ accepted: true, cards: cards.length, packs: packs.length, serials: serials.length }, { status: 202 });
}
