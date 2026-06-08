// lib/concierge/pinnacle-router.ts
//
// Centralised routing for the support-chat tools when the active collection
// is Disney Pinnacle. Pinnacle FMV now lives PER-RENDER in pinnacle_catalog
// (render_id PK, with fmv_usd / fmv_confidence / floor_ask / fmv_wap_usd
// denormalized onto each render). The legacy per-edition blend in
// pinnacle_fmv_snapshots is retired — every concierge answer quotes the
// per-render FMV.
//
// Character-correctness is non-negotiable: legacy_edition_key is SET-LEVEL
// (e.g. STAR-OEV1-SWAL:Golden:1 spans all 26 Star Wars characters), so any
// lookup that has a character signal gates on it. (character, set, variant)
// is 1:1 with a render in pinnacle_catalog, so once character is fixed the
// match is exact; where multiple renders remain (a key with no further
// signal) we collapse to a representative — most-traded over 30d, tiebreak
// highest FMV — mirroring the DB helper get_pinnacle_edition_fmv_collapsed,
// and surface fmv_min/fmv_max/render_count so the spread is never hidden.
//
// Each function here returns a JSON-shaped string identical to its unified
// counterpart in app/api/support-chat/route.ts so the LLM sees a consistent
// tool result regardless of which path produced it.

import { PINNACLE_MARKETPLACE_URL } from "@/lib/pinnacle/pinnacleTypes"

const PINNACLE_COLLECTION_ID = "disney-pinnacle"

export function isPinnacle(collectionId: string | null | undefined): boolean {
  return collectionId === PINNACLE_COLLECTION_ID
}

// Unified row shape returned to the model — match the keys used in the
// non-Pinnacle branches so the LLM doesn't see drift.
interface DealRow {
  player: string | null
  set: string | null
  tier: string | null
  serial: number | null
  price: number
  fmv: number | null
  discount_pct: number | null
  source: string
  buy_url: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supabase = any

// A single priced render pulled from pinnacle_catalog.
interface CatalogRender {
  render_id: string
  character_name: string | null
  set_name: string | null
  variant: string | null
  legacy_edition_key: string | null
  fmv_usd: number
  fmv_confidence: string | null
  fmv_wap_usd: number | null
  floor_ask: number | null
  fmv_sales_count_30d: number | null
  fmv_days_since_sale: number | null
  fmv_computed_at: string | null
  fmv_algo_version: string | null
  total_minted: number | null
}

// Collapse one-or-more renders to a representative (most-traded 30d, tiebreak
// highest FMV) plus the full-set spread. Mirrors get_pinnacle_edition_fmv_collapsed.
function collapseRenders(rows: CatalogRender[]): {
  rep: CatalogRender
  fmv_min: number
  fmv_max: number
  render_count: number
} | null {
  const priced = rows.filter((r) => r.fmv_usd != null)
  if (!priced.length) return null
  const sorted = [...priced].sort((a, b) => {
    const sa = a.fmv_sales_count_30d ?? -1
    const sb = b.fmv_sales_count_30d ?? -1
    if (sb !== sa) return sb - sa
    return (b.fmv_usd ?? 0) - (a.fmv_usd ?? 0)
  })
  const fmvs = priced.map((r) => Number(r.fmv_usd))
  return {
    rep: sorted[0],
    fmv_min: Math.min(...fmvs),
    fmv_max: Math.max(...fmvs),
    render_count: priced.length,
  }
}

const CATALOG_FMV_COLUMNS =
  "render_id, character_name, set_name, variant, legacy_edition_key, fmv_usd, fmv_confidence, fmv_wap_usd, floor_ask, fmv_sales_count_30d, fmv_days_since_sale, fmv_computed_at, fmv_algo_version, total_minted"

// Pinnacle deal-finding reads the per-render spine pinnacle_catalog directly:
// (character, set, variant) is 1:1 with a render, and each render carries its
// own live floor_ask (refreshed daily from the Pinnacle studio GraphQL) and
// its own per-render fmv_usd. The legacy pinnacle_cached_listings table was
// sourced from Flowty, which shut down 2026-05-13 and now serves a frozen
// 2026-05-27 snapshot — reading it produced fabricated discounts off stale /
// uniform-$1 asks. Reading the catalog row keeps ask, FMV, and the discount on
// the SAME render, so character/FMV can never leak across pins.
const CATALOG_DEAL_COLUMNS =
  "render_id, character_name, set_name, variant, floor_ask, fmv_usd, fmv_confidence"

interface CatalogDealRow {
  render_id: string
  character_name: string | null
  set_name: string | null
  variant: string | null
  floor_ask: number | null
  fmv_usd: number | null
  fmv_confidence: string | null
}

export async function searchPinnacleDeals(
  supabase: Supabase,
  input: { player?: string; tier?: string; maxPrice?: number; minDiscount?: number; limit?: number },
  opts: { source: "live" | "catalog" } = { source: "live" }
): Promise<string> {
  try {
    const cap = Math.min(Math.max(input.limit ?? 8, 1), 20)
    let query = supabase
      .from("pinnacle_catalog")
      .select(CATALOG_DEAL_COLUMNS)
      // floor_ask present = the render is currently listed on the marketplace.
      .not("floor_ask", "is", null)
      .order("floor_ask", { ascending: true })
      .limit(cap)
    // Pinnacle uses character_name (not player_name) and variant (not tier).
    if (input.player) query = query.ilike("character_name", `%${input.player}%`)
    if (input.tier) query = query.ilike("variant", `%${input.tier}%`)
    if (input.maxPrice) query = query.lte("floor_ask", input.maxPrice)
    const { data: rows, error } = await query
    if (error) return JSON.stringify({ status: "error", message: error.message })
    if (!rows || rows.length === 0) {
      return JSON.stringify({ status: "no_results", message: "No Pinnacle listings found matching those criteria." })
    }
    const enriched: DealRow[] = (rows as CatalogDealRow[]).map((r) => {
      const ask = Number(r.floor_ask)
      const fmv = r.fmv_usd != null ? Number(r.fmv_usd) : null
      const discount_pct = fmv != null && fmv > 0 ? Math.round(((fmv - ask) / fmv) * 100) : null
      return {
        player: r.character_name,
        set: r.set_name,
        tier: r.variant,
        serial: null,
        price: ask,
        fmv,
        discount_pct,
        source: opts.source === "live" ? "pinnacle" : "catalog",
        buy_url: PINNACLE_MARKETPLACE_URL,
      }
    })
    let results = enriched
    if (input.minDiscount) {
      results = results.filter(d => d.discount_pct != null && d.discount_pct >= input.minDiscount!)
    }
    if (results.length === 0) {
      return JSON.stringify({ status: "no_results", message: "No Pinnacle listings matched the discount threshold." })
    }
    return JSON.stringify({
      status: "ok",
      results: results.slice(0, input.limit ?? 8),
      total: results.length,
      collectionId: PINNACLE_COLLECTION_ID,
      source: opts.source === "live" ? "pinnacle_native" : "pinnacle_catalog",
    })
  } catch (err) {
    return JSON.stringify({
      status: "error",
      message: err instanceof Error ? err.message : "pinnacle search failed",
    })
  }
}

// Resolve per-render FMV for a legacy edition_key. The key is set-level and
// can span characters/renders, so we collapse to a representative and report
// the spread. Returns null when no priced render exists for the key.
async function fetchRenderFmvByKey(
  supabase: Supabase,
  editionKey: string
): Promise<{ rep: CatalogRender; fmv_min: number; fmv_max: number; render_count: number } | null> {
  const { data: rows } = await supabase
    .from("pinnacle_catalog")
    .select(CATALOG_FMV_COLUMNS)
    .eq("legacy_edition_key", editionKey)
    .not("fmv_usd", "is", null)
  return collapseRenders((rows ?? []) as CatalogRender[])
}

export async function getPinnacleFmv(
  supabase: Supabase,
  input: { editionKey?: string; playerName?: string }
): Promise<string> {
  try {
    if (input.editionKey) {
      const collapsed = await fetchRenderFmvByKey(supabase, input.editionKey)
      if (!collapsed) {
        return JSON.stringify({
          status: "no_data",
          message: "No FMV snapshot yet for that Pinnacle edition.",
          edition: { edition: input.editionKey },
        })
      }
      const rep = collapsed.rep
      return JSON.stringify({
        status: "ok",
        edition: input.editionKey,
        player: rep.character_name,
        set: rep.set_name,
        tier: rep.variant,
        fmv: Number(rep.fmv_usd),
        confidence: (rep.fmv_confidence ?? "LOW").toString().toLowerCase(),
        wap_usd: rep.fmv_wap_usd != null ? Number(rep.fmv_wap_usd) : null,
        floor_usd: rep.floor_ask != null ? Number(rep.floor_ask) : null,
        sales_count_30d: rep.fmv_sales_count_30d ?? null,
        days_since_sale: rep.fmv_days_since_sale ?? null,
        // The legacy key can span multiple renders/characters — surface the
        // per-render spread so the quoted number is never mistaken for a blend.
        fmv_render_range: collapsed.render_count > 1
          ? { min: collapsed.fmv_min, max: collapsed.fmv_max, renders: collapsed.render_count }
          : null,
        updatedAt: rep.fmv_computed_at,
        collectionId: PINNACLE_COLLECTION_ID,
      })
    }
    if (input.playerName) {
      const { data: rows } = await supabase
        .from("pinnacle_catalog")
        .select(CATALOG_FMV_COLUMNS)
        .ilike("character_name", `%${input.playerName}%`)
        .not("fmv_usd", "is", null)
        .order("fmv_sales_count_30d", { ascending: false })
        .limit(50)
      if (!rows || rows.length === 0) {
        return JSON.stringify({ status: "not_found", message: "No priced Pinnacle renders found for that character." })
      }
      return JSON.stringify({
        status: "ok",
        results: (rows as CatalogRender[]).slice(0, 5).map((r) => ({
          player: r.character_name,
          set: r.set_name,
          tier: r.variant,
          low_ask: r.floor_ask != null ? Number(r.floor_ask) : null,
          fmv: Number(r.fmv_usd),
          confidence: (r.fmv_confidence ?? "LOW").toString().toLowerCase(),
        })),
        collectionId: PINNACLE_COLLECTION_ID,
      })
    }
    return JSON.stringify({ status: "error", message: "Provide editionKey or playerName." })
  } catch (err) {
    return JSON.stringify({
      status: "error",
      message: err instanceof Error ? err.message : "pinnacle fmv lookup failed",
    })
  }
}

export async function explainPinnacleFmv(
  supabase: Supabase,
  input: { editionKey: string }
): Promise<string> {
  try {
    if (!input.editionKey) return JSON.stringify({ status: "error", message: "editionKey is required" })
    const collapsed = await fetchRenderFmvByKey(supabase, input.editionKey)
    if (!collapsed) {
      return JSON.stringify({ status: "no_data", message: "No FMV snapshot yet for that Pinnacle edition." })
    }
    const rep = collapsed.rep
    const computedAgo = rep.fmv_computed_at
      ? `${Math.round((Date.now() - new Date(rep.fmv_computed_at).getTime()) / 60000)} minutes ago`
      : "unknown"
    const salesNote = rep.fmv_sales_count_30d ? `across ${rep.fmv_sales_count_30d} recent sales` : "with limited sales data"
    const fmv = Number(rep.fmv_usd)
    const wap = rep.fmv_wap_usd != null ? Number(rep.fmv_wap_usd) : 0
    const floor = rep.floor_ask != null ? Number(rep.floor_ask) : 0
    const rangeNote = collapsed.render_count > 1
      ? ` This key spans ${collapsed.render_count} renders ranging $${collapsed.fmv_min.toFixed(2)}–$${collapsed.fmv_max.toFixed(2)}; the figure above is the most-traded render.`
      : ""
    const explanation = `Pinnacle FMV is $${fmv.toFixed(2)} (${rep.fmv_confidence} confidence) based on a 30-day WAP of $${wap.toFixed(2)} ${salesNote}. Floor is $${floor.toFixed(2)}. Last computed ${computedAgo}.${rangeNote}`
    return JSON.stringify({
      status: "ok",
      player_name: rep.character_name ?? null,
      set_name: rep.set_name ?? null,
      tier: rep.variant ?? null,
      fmv_usd: rep.fmv_usd,
      confidence: rep.fmv_confidence,
      wap_usd: rep.fmv_wap_usd,
      floor_price_usd: rep.floor_ask,
      computed_at: rep.fmv_computed_at,
      explanation,
      collectionId: PINNACLE_COLLECTION_ID,
    })
  } catch (err) {
    return JSON.stringify({
      status: "error",
      message: err instanceof Error ? err.message : "pinnacle explain_fmv failed",
    })
  }
}

// Used by search_across_collections to fold Pinnacle results into the
// combined cross-collection group payload.
export async function searchPinnacleByName(
  supabase: Supabase,
  name: string,
  perCollection: number
): Promise<{
  collection: string
  collectionId: string
  results: Array<{
    player: string | null
    set: string | null
    tier: string | null
    serial: number | null
    price: number | null
    fmv: number | null
    discount_pct: number | null
    buy_url: string
  }>
}> {
  // Per-render spine (pinnacle_catalog), same rationale as searchPinnacleDeals:
  // floor_ask + fmv_usd live on the same render row, so no cross-pin leak and
  // no dependency on the frozen dead-Flowty pinnacle_cached_listings table.
  const { data: rows } = await supabase
    .from("pinnacle_catalog")
    .select(CATALOG_DEAL_COLUMNS)
    .not("floor_ask", "is", null)
    .ilike("character_name", `%${name}%`)
    .order("floor_ask", { ascending: true })
    .limit(perCollection)
  return {
    collection: "Disney Pinnacle",
    collectionId: PINNACLE_COLLECTION_ID,
    results: ((rows ?? []) as CatalogDealRow[]).map((r) => {
      const ask = r.floor_ask != null ? Number(r.floor_ask) : null
      const fmv = r.fmv_usd != null ? Number(r.fmv_usd) : null
      const discount_pct =
        fmv != null && fmv > 0 && ask != null ? Math.round(((fmv - ask) / fmv) * 100) : null
      return {
        player: r.character_name,
        set: r.set_name,
        tier: r.variant,
        serial: null,
        price: ask,
        fmv,
        discount_pct,
        buy_url: PINNACLE_MARKETPLACE_URL,
      }
    }),
  }
}
