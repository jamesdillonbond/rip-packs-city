// Panini ingest normalizers — pure functions extracted from app/api/cron/panini-ingest/route.ts
// so the mapping logic (special flags, nation, pack id, price/tier parsing) is unit-testable.
// Every shape here is defensive + raw-preserving because the upstream getCardMarketStats /
// getPskuTotalCardsList / getPackMarketStats field names were reverse-engineered, not documented.

export const PANINI_UUID = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b";

const TIER: Record<string, string> = { Uncommon: "COMMON", Rare: "RARE", "Ultra Rare": "RARE", Epic: "LEGENDARY", Legendary: "ULTIMATE" };
const FOTL = /aguila|maple leaf|old glory|nebula/i;

const posOrNull = (x: any): number | null => (Number.isFinite(+x) && +x > 0 ? +x : null);

export function parallelFamily(cardset = ""): string {
  if (FOTL.test(cardset)) return "fotl_exclusive";
  if (/^base/i.test(cardset)) return "base";
  if (/silver|gold|black/i.test(cardset)) return "tiered_insert";
  return "non_tiered_insert";
}

// getCardMarketStats.data -> panini_editions row. Market fields may be nested under market_stats OR
// top-level (grid items) — fall back to the object itself. nation comes from the runner's __nation tag.
export function toEditionRow(c: any, nowIso: string) {
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

// Edition FMV snapshot: sales-first (avg_sale, confidence by txn count), ASK_ONLY floor×0.9 fallback.
export function toFmvRow(c: any, nowIso: string) {
  const ms = c?.market_stats ?? c ?? {};
  const txns = Number(ms.volume_txns) || 0;
  let fmv: number | null = null, confidence = "NO_DATA";
  if (txns > 0 && Number.isFinite(+ms.recent_sale)) { fmv = +ms.avg_sale || +ms.recent_sale; confidence = txns >= 3 ? "HIGH" : txns === 2 ? "MEDIUM" : "LOW"; }
  else if (Number.isFinite(+ms.floor_price) && +ms.floor_price > 0) { fmv = Math.round(+ms.floor_price * 0.9); confidence = "ASK_ONLY"; }
  if (fmv == null) return null;
  return { edition_id: String(c?.sku ?? c?.psku), fmv_usd: fmv, confidence, algo_version: "panini-1.0.0", computed_at: nowIso };
}

// getPackMarketStats.data -> panini_pack_state row. Pack id prefers the runner's __pack_id (parsed from
// the pack URL) so FOTL 1039 doesn't collide with Hobby 1038. Secondary price captured for net rip-EV.
export function toPackRow(p: any, nowIso: string) {
  const ms = p?.market_stats ?? p ?? {};
  const packId = String(p?.__pack_id ?? p?.pack_sku ?? p?.collection_name ?? "");
  return {
    id: packId,
    collection_id: PANINI_UUID,
    pack_type: /fotl|first off/i.test(p?.pack_name ?? "") || packId === "1039" ? "fotl" : "hobby",
    price_usd: null,
    cards_per_pack: Number(p?.cards_per_subpack) || null,
    packs_total: Number(p?.total_pack_qty) || null,
    packs_remaining: Number.isFinite(+ms.unopen_pack_count) ? +ms.unopen_pack_count : null,
    floor_usd: posOrNull(ms.floor_price ?? p?.floor_price),
    avg_sale_usd: posOrNull(ms.avg_sale ?? p?.avg_sale),
    recent_sale_usd: posOrNull(ms.recent_sale ?? p?.recent_sale),
    top_sale_usd: posOrNull(ms.top_sale ?? p?.top_sale),
    raw: p ?? null,
    gross_ev_usd: null,
    net_ev_usd: null,
    updated_at: nowIso,
  };
}

// getPskuTotalCardsList product -> panini_card_serials row. nft_type is a comma-flag list; best_offer /
// brought_at_price (real last sale) / state captured for the demand + deal signals. raw preserves all 45 fields.
export function toSerialRow(p: any, nowIso: string) {
  const sku = p?.sku ?? p?.psku_serial ?? null;
  const editionPsku = p?.psku ?? (typeof sku === "string" ? sku.replace(/_(\d+)_(\d+)$/, "") : null);
  const serial = p?.serial ?? p?.serial_number ?? p?.mint_number ?? (typeof sku === "string" ? Number((sku.match(/_(\d+)_\d+$/) || [])[1]) : null);
  const cap = p?.end_seq ?? p?.mint_cap ?? (typeof sku === "string" ? Number((sku.match(/_(\d+)$/) || [])[1]) : null);
  const price = [p?.buy_now_price, p?.price, p?.final_price, p?.amount].find((x) => Number.isFinite(+x) && +x > 0);
  const owner = p?.owner ?? p?.username ?? p?.cname ?? p?.fullname ?? null;
  const nftType = p?.nft_type ?? null;
  return {
    sku: sku ? String(sku) : null,
    edition_external_id: editionPsku ? String(editionPsku) : null,
    serial_number: Number.isFinite(+serial) ? +serial : null,
    mint_cap: Number.isFinite(+cap) ? +cap : null,
    price_usd: price != null ? +price : null,
    best_offer_usd: posOrNull(p?.best_offer),
    last_sale_usd: posOrNull(p?.brought_at_price),
    last_sale_at: p?.brought_at_time ? String(p.brought_at_time) : null,
    is_listed: p?.state ? p.state === "AVAILABLE" : null,
    owner: owner != null ? String(owner) : null,
    nft_type: nftType != null && nftType !== "" ? String(nftType) : null,
    raw: p ?? null,
    captured_at: nowIso,
  };
}
