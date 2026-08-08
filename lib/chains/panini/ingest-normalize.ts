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
// brought_at_price / state captured for the demand + deal signals. raw preserves all 45 fields.
//
// ⚠ brought_at_price has returned JSON null for every serial since 2026-07-29 and CANNOT be
// recovered by changing the request: the 2026-08-08 A/B varied listType across all four real
// values AND a nonsense control (zzz_invalid_control), and every one returned the identical
// 10 rows with 10 nulls — the parameter is INERT, and a fully signed request from Panini's own
// front end gets the same nulls we do. Realized prices now come from the nftSalesData op
// instead (toSaleRecord below). Do not re-attempt a request-shape fix here.
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

// --- nftSalesData -> realized sales (the replacement price path, 2026-08-08) ---------------
// The SALES HISTORY tab fires op `nftSalesData`, which returns REALIZED sales with prices
// present: { url_key, txn_amount, buyer_name, seller_name, purchased_date, transaction_hash,
// sale_type }. url_key is byte-identical to panini_card_serials.sku (verified live against
// packcard-2332_486956_12680604_40__10_10), so it joins with no mapping work.
//
// SCOPE: only amount + timestamp are persisted, into the existing last_sale_usd/_at columns.
// buyer/seller/hash/sale_type ride along in the POST payload and are preserved verbatim in the
// runner's local backup JSONL, but are NOT written to a table yet — a sales-feed table would be
// schema'd off a single observed psku (6 records), and pagination depth is unmeasured. Build it
// once real coverage is measured; the backup file makes that backfillable.

// Panini sends purchased_date zone-less ("2026-08-02 10:08:02"). Stamp it UTC explicitly rather
// than letting the column's input parser assume a zone — an unlabelled local time would land
// hours off and look like a real price move. Anything already carrying a zone passes through.
export function toSaleTimestamp(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  return m ? `${m[1]}T${m[2]}Z` : s;
}

export type PaniniSale = { sku: string; amount_usd: number; sold_at: string | null };

// One nftSalesData record -> normalized sale, or null if it can't be trusted as a priced sale.
// Field names are read defensively (same posture as the rest of this file): the op was observed
// on exactly one psku, so alternates are accepted rather than assumed absent.
export function toSaleRecord(s: any): PaniniSale | null {
  const sku = s?.url_key ?? s?.sku ?? null;
  const amount = [s?.txn_amount, s?.amount, s?.sale_price, s?.price].find((x) => Number.isFinite(+x) && +x > 0);
  if (sku == null || String(sku) === "" || amount == null) return null;
  return { sku: String(sku), amount_usd: +amount, sold_at: toSaleTimestamp(s?.purchased_date ?? s?.sold_at ?? s?.txn_date ?? null) };
}

// Collapse a batch of sale records to the NEWEST sale per sku — that is what last_sale_usd means.
// A dated sale always beats an undated one; between two undated records the first wins (arbitrary
// but stable, and an undated record can never displace a dated one).
export function latestSalesBySku(records: any[]): Map<string, PaniniSale> {
  const by = new Map<string, PaniniSale>();
  const t = (r: PaniniSale) => (r.sold_at ? Date.parse(r.sold_at) : NaN);
  for (const raw of records ?? []) {
    const r = toSaleRecord(raw);
    if (!r) continue;
    const prev = by.get(r.sku);
    if (!prev) { by.set(r.sku, r); continue; }
    const a = t(r), b = t(prev);
    if (Number.isFinite(a) && (!Number.isFinite(b) || a > b)) by.set(r.sku, r);
  }
  return by;
}

// Guard for the monotonic-write filter in the ingest route: only a strict, zone-explicit ISO
// stamp may be interpolated into a PostgREST .or() expression. Anything else falls back to an
// unconditional write, so an odd upstream date can never shape a filter string.
export function isStrictIsoUtc(v: string | null): v is string {
  return !!v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/.test(v);
}
