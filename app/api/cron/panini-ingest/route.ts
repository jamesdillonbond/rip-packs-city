// app/api/cron/panini-ingest/route.ts
//
// SHIPPED 2026-07-16 as INERT infrastructure — receives nothing until the residential
// runner (scripts/ingest-panini-runner.mjs) runs on Trevor's logged-in box. No cron wired.
// Tables applied via audit_20260716_panini_schema_inert. See docs/strategy/panini-roadmap-2026-07-16.md.
//
// PUSH ingest for Panini Plane-A: receives batches captured by the residential runner
// (docs/drafts/panini/ingest-panini-runner.mjs) and writes panini_editions /
// panini_pack_state / panini_fmv_snapshots. The runner does all auth + signing in a
// real logged-in browser; this route only normalizes + upserts (service-role).
//
// Body shape (all optional arrays):
//   { cards:   [ getCardMarketStats.data, ... ],
//     packs:   [ getPackMarketStats.data, ... ],
//     serials: [ getPskuTotalCardsList ...products, ... ] }   // serials -> panini_card_serials (special serials)
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
  // Live-verified 2026-07-16: market fields can sit at the object TOP LEVEL (grid items expose
  // avg_sale/best_offer/end_seq directly), not always nested under market_stats — fall back to c itself.
  const ms = c?.market_stats ?? c ?? {};
  const cap = Number(c?.end_seq) || null;
  return {
    id: String(c?.sku ?? c?.psku),
    external_id: String(c?.psku ?? c?.sku),
    collection_id: PANINI_UUID,
    player_name: c?.athlete ?? null,
    nation: c?.__nation ?? c?.team ?? c?.nation ?? null,
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
  const ms = c?.market_stats ?? c ?? {};
  const txns = Number(ms.volume_txns) || 0;
  let fmv: number | null = null, confidence = "NO_DATA";
  if (txns > 0 && Number.isFinite(+ms.recent_sale)) { fmv = +ms.avg_sale || +ms.recent_sale; confidence = txns >= 3 ? "HIGH" : txns === 2 ? "MEDIUM" : "LOW"; }
  else if (Number.isFinite(+ms.floor_price) && +ms.floor_price > 0) { fmv = Math.round(+ms.floor_price * 0.9); confidence = "ASK_ONLY"; }
  if (fmv == null) return null;
  return { edition_id: String(c?.sku ?? c?.psku), fmv_usd: fmv, confidence, algo_version: "panini-1.0.0", computed_at: nowIso };
}

function toPackRow(p: any, nowIso: string) {
  const ms = p?.market_stats ?? p ?? {};
  const packId = String(p?.__pack_id ?? p?.pack_sku ?? p?.collection_name ?? "");
  const posOrNull = (x: any) => (Number.isFinite(+x) && +x > 0 ? +x : null);
  return {
    id: packId,
    collection_id: PANINI_UUID,
    pack_type: /fotl|first off/i.test(p?.pack_name ?? "") || packId === "1039" ? "fotl" : "hobby",
    price_usd: null,
    cards_per_pack: Number(p?.cards_per_subpack) || null,
    packs_total: Number(p?.total_pack_qty) || null,
    packs_remaining: Number.isFinite(+ms.unopen_pack_count) ? +ms.unopen_pack_count : null,
    floor_usd: posOrNull(ms.floor_price ?? p?.floor_price),        // pack secondary floor
    avg_sale_usd: posOrNull(ms.avg_sale ?? p?.avg_sale),
    recent_sale_usd: posOrNull(ms.recent_sale ?? p?.recent_sale),
    top_sale_usd: posOrNull(ms.top_sale ?? p?.top_sale),
    raw: p ?? null,                                                // preserve for field-name correction
    gross_ev_usd: null,
    net_ev_usd: null,
    updated_at: nowIso,
  };
}

// getPskuTotalCardsList product -> panini_card_serials row. Field names are mapped defensively
// (the exact shape wasn't captured live); `raw` preserves the whole product so the mapping can be
// refined later and a replay re-lands it. nft_type carries the special-serial flag.
function toSerialRow(p: any, nowIso: string) {
  const sku = p?.sku ?? p?.psku_serial ?? null;
  const editionPsku = p?.psku ?? (typeof sku === "string" ? sku.replace(/_(\d+)_(\d+)$/, "") : null);
  const serial = p?.serial ?? p?.serial_number ?? p?.mint_number ?? (typeof sku === "string" ? Number((sku.match(/_(\d+)_\d+$/) || [])[1]) : null);
  const cap = p?.end_seq ?? p?.mint_cap ?? (typeof sku === "string" ? Number((sku.match(/_(\d+)$/) || [])[1]) : null);
  const price = [p?.buy_now_price, p?.price, p?.final_price, p?.amount].find((x) => Number.isFinite(+x) && +x > 0);
  const owner = p?.owner ?? p?.username ?? p?.cname ?? p?.fullname ?? null;
  const nftType = p?.nft_type ?? null;
  const posOrNull = (x: any) => (Number.isFinite(+x) && +x > 0 ? +x : null);
  return {
    sku: sku ? String(sku) : null,
    edition_external_id: editionPsku ? String(editionPsku) : null,
    serial_number: Number.isFinite(+serial) ? +serial : null,
    mint_cap: Number.isFinite(+cap) ? +cap : null,
    price_usd: price != null ? +price : null,            // buy-now ask
    best_offer_usd: posOrNull(p?.best_offer),            // highest standing offer
    last_sale_usd: posOrNull(p?.brought_at_price),       // real last secondary sale (0 = pack-pulled)
    last_sale_at: p?.brought_at_time ? String(p.brought_at_time) : null,
    is_listed: p?.state ? p.state === "AVAILABLE" : null,
    owner: owner != null ? String(owner) : null,
    nft_type: nftType != null && nftType !== "" ? String(nftType) : null,
    raw: p ?? null,
    captured_at: nowIso,
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
  // Accept either the INGEST or CRON secret (same dual-token posture as proxy.ts) so the
  // residential runner works whichever value the operator has on hand.
  const auth = req.headers.get("authorization") || "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const cron = process.env.CRON_SECRET;
  const ok = (ingest && auth === `Bearer ${ingest}`) || (cron && auth === `Bearer ${cron}`);
  if (!ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
      // serials -> panini_card_serials (dedup by sku within the batch; upsert on sku)
      let serialsWritten = 0;
      if (serials.length) {
        const bySku = new Map<string, any>();
        for (const sp of serials) { const r = toSerialRow(sp, nowIso); if (r.sku && r.edition_external_id) bySku.set(r.sku, r); }
        const serialRows = [...bySku.values()];
        for (let i = 0; i < serialRows.length; i += CHUNK) {
          const { data, error } = await (supabaseAdmin as any).from("panini_card_serials").upsert(serialRows.slice(i, i + CHUNK), { onConflict: "sku" }).select("id");
          if (error) console.log(`[${PIPELINE}] serials upsert: ${error.message}`); else serialsWritten += data?.length ?? 0;
        }
      }
      await logRun(startedAtIso, found, written, true, null, { editions: written, fmv: fmvRows.length, packs: packs.length, serials: serialsWritten });
    } catch (e) {
      await logRun(startedAtIso, found, written, false, e instanceof Error ? e.message : String(e), {});
    }
  });
  return NextResponse.json({ accepted: true, cards: cards.length, packs: packs.length }, { status: 202 });
}
