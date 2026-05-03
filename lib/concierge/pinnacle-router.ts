// lib/concierge/pinnacle-router.ts
//
// Centralised routing for the support-chat tools when the active collection
// is Disney Pinnacle. Pinnacle data lives in pinnacle_editions /
// pinnacle_cached_listings / pinnacle_fmv_snapshots — a parallel schema
// that does NOT live in the unified editions / cached_listings /
// fmv_snapshots tables every other collection uses.
//
// Each function here returns a JSON-shaped string identical to its unified
// counterpart in app/api/support-chat/route.ts so the LLM sees a consistent
// tool result regardless of which path produced it.

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

async function fetchFmvByEditionKeys(supabase: Supabase, editionKeys: string[]) {
  if (!editionKeys.length) return new Map<string, number>()
  // pinnacle_fmv_snapshots.edition_id matches pinnacle_editions.id (text), but
  // pinnacle_cached_listings joins by edition_key. Map listings → editions →
  // FMV via edition_key → id.
  const { data: editions } = await supabase
    .from("pinnacle_editions")
    .select("id, edition_key")
    .in("edition_key", editionKeys)
  const keyToId = new Map<string, string>()
  for (const row of editions ?? []) {
    if (row.edition_key && row.id) keyToId.set(row.edition_key, row.id)
  }
  const ids = Array.from(new Set(keyToId.values()))
  if (!ids.length) return new Map<string, number>()
  const { data: fmvRows } = await supabase
    .from("pinnacle_fmv_snapshots")
    .select("edition_id, fmv_usd, computed_at")
    .in("edition_id", ids)
    .order("computed_at", { ascending: false })
  // Take the most recent snapshot per edition_id.
  const idToFmv = new Map<string, number>()
  for (const row of fmvRows ?? []) {
    if (!idToFmv.has(row.edition_id) && row.fmv_usd != null) {
      idToFmv.set(row.edition_id, Number(row.fmv_usd))
    }
  }
  // Project back onto edition_key.
  const keyToFmv = new Map<string, number>()
  for (const [key, id] of keyToId) {
    const fmv = idToFmv.get(id)
    if (fmv != null) keyToFmv.set(key, fmv)
  }
  return keyToFmv
}

export async function searchPinnacleDeals(
  supabase: Supabase,
  input: { player?: string; tier?: string; maxPrice?: number; minDiscount?: number; limit?: number },
  opts: { source: "live" | "catalog" } = { source: "live" }
): Promise<string> {
  try {
    let query = supabase
      .from("pinnacle_cached_listings")
      .select("id, edition_key, character_name, franchise, variant_type, set_name, ask_price, buy_url")
      .order("ask_price", { ascending: true })
      .limit(Math.min(Math.max(input.limit ?? 8, 1), 20))
    // Pinnacle uses character_name (not player_name) and variant_type (not tier).
    // Map model-supplied filters onto the right columns.
    if (input.player) query = query.ilike("character_name", `%${input.player}%`)
    if (input.tier) query = query.ilike("variant_type", `%${input.tier}%`)
    if (input.maxPrice) query = query.lte("ask_price", input.maxPrice)
    const { data: rows, error } = await query
    if (error) return JSON.stringify({ status: "error", message: error.message })
    if (!rows || rows.length === 0) {
      return JSON.stringify({ status: "no_results", message: "No Pinnacle listings found matching those criteria." })
    }
    const keyToFmv = await fetchFmvByEditionKeys(
      supabase,
      rows.map((r: { edition_key: string }) => r.edition_key).filter(Boolean)
    )
    const enriched: DealRow[] = rows.map((r: {
      edition_key: string; character_name: string | null; franchise: string | null;
      variant_type: string | null; set_name: string | null; ask_price: number; buy_url: string | null;
    }) => {
      const fmv = keyToFmv.get(r.edition_key) ?? null
      const ask = Number(r.ask_price)
      const discount_pct = fmv != null && fmv > 0 ? Math.round(((fmv - ask) / fmv) * 100) : null
      return {
        player: r.character_name,
        set: r.set_name ?? r.franchise,
        tier: r.variant_type,
        serial: null,
        price: ask,
        fmv,
        discount_pct,
        source: opts.source === "live" ? "pinnacle" : "catalog",
        buy_url: r.buy_url ?? "",
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

export async function getPinnacleFmv(
  supabase: Supabase,
  input: { editionKey?: string; playerName?: string }
): Promise<string> {
  try {
    if (input.editionKey) {
      const { data: edition } = await supabase
        .from("pinnacle_editions")
        .select("id, edition_key, character_name, franchise, variant_type, set_name, ask_price")
        .eq("edition_key", input.editionKey)
        .maybeSingle()
      if (!edition) {
        return JSON.stringify({ status: "not_found", message: "Pinnacle edition not found for that key." })
      }
      const { data: snap } = await supabase
        .from("pinnacle_fmv_snapshots")
        .select("fmv_usd, confidence, computed_at, wap_usd, floor_usd, sales_count_30d, days_since_sale")
        .eq("edition_id", edition.id)
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!snap) {
        return JSON.stringify({
          status: "no_data",
          message: "No FMV snapshot yet for that Pinnacle edition.",
          edition: {
            character: edition.character_name,
            set: edition.set_name ?? edition.franchise,
            variant: edition.variant_type,
            ask_price: edition.ask_price != null ? Number(edition.ask_price) : null,
          },
        })
      }
      return JSON.stringify({
        status: "ok",
        edition: input.editionKey,
        player: edition.character_name,
        set: edition.set_name ?? edition.franchise,
        tier: edition.variant_type,
        fmv: Number(snap.fmv_usd),
        confidence: (snap.confidence ?? "LOW").toString().toLowerCase(),
        wap_usd: snap.wap_usd != null ? Number(snap.wap_usd) : null,
        floor_usd: snap.floor_usd != null ? Number(snap.floor_usd) : null,
        sales_count_30d: snap.sales_count_30d ?? null,
        days_since_sale: snap.days_since_sale ?? null,
        updatedAt: snap.computed_at,
        collectionId: PINNACLE_COLLECTION_ID,
      })
    }
    if (input.playerName) {
      const { data: rows } = await supabase
        .from("pinnacle_editions")
        .select("id, edition_key, character_name, franchise, variant_type, set_name, ask_price")
        .ilike("character_name", `%${input.playerName}%`)
        .limit(5)
      if (!rows || rows.length === 0) {
        return JSON.stringify({ status: "not_found", message: "No Pinnacle editions found for that character." })
      }
      const ids = rows.map((r: { id: string }) => r.id)
      const { data: snaps } = await supabase
        .from("pinnacle_fmv_snapshots")
        .select("edition_id, fmv_usd, computed_at")
        .in("edition_id", ids)
        .order("computed_at", { ascending: false })
      const idToFmv = new Map<string, number>()
      for (const s of snaps ?? []) {
        if (!idToFmv.has(s.edition_id) && s.fmv_usd != null) idToFmv.set(s.edition_id, Number(s.fmv_usd))
      }
      return JSON.stringify({
        status: "ok",
        results: rows.map((r: {
          id: string; character_name: string | null; franchise: string | null;
          variant_type: string | null; set_name: string | null; ask_price: number | null;
        }) => ({
          player: r.character_name,
          set: r.set_name ?? r.franchise,
          tier: r.variant_type,
          low_ask: r.ask_price != null ? Number(r.ask_price) : null,
          fmv: idToFmv.get(r.id) ?? null,
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
    const { data: edition } = await supabase
      .from("pinnacle_editions")
      .select("id, edition_key, character_name, franchise, variant_type, set_name")
      .eq("edition_key", input.editionKey)
      .maybeSingle()
    if (!edition) {
      return JSON.stringify({ status: "not_found", message: "Pinnacle edition not found for that key." })
    }
    const { data: snap } = await supabase
      .from("pinnacle_fmv_snapshots")
      .select("fmv_usd, confidence, wap_usd, floor_usd, computed_at, sales_count_30d, days_since_sale, algo_version")
      .eq("edition_id", edition.id)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!snap) {
      return JSON.stringify({ status: "no_data", message: "No FMV snapshot yet for that Pinnacle edition." })
    }
    const computedAgo = snap.computed_at
      ? `${Math.round((Date.now() - new Date(snap.computed_at).getTime()) / 60000)} minutes ago`
      : "unknown"
    const salesNote = snap.sales_count_30d ? `across ${snap.sales_count_30d} recent sales` : "with limited sales data"
    const fmv = Number(snap.fmv_usd)
    const wap = snap.wap_usd != null ? Number(snap.wap_usd) : 0
    const floor = snap.floor_usd != null ? Number(snap.floor_usd) : 0
    const explanation = `Pinnacle FMV is $${fmv.toFixed(2)} (${snap.confidence} confidence) based on a 30-day WAP of $${wap.toFixed(2)} ${salesNote}. Floor is $${floor.toFixed(2)}. Last computed ${computedAgo}.`
    return JSON.stringify({
      status: "ok",
      player_name: edition.character_name ?? null,
      set_name: edition.set_name ?? edition.franchise ?? null,
      tier: edition.variant_type ?? null,
      fmv_usd: snap.fmv_usd,
      confidence: snap.confidence,
      wap_usd: snap.wap_usd,
      floor_price_usd: snap.floor_usd,
      computed_at: snap.computed_at,
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
  const { data: rows } = await supabase
    .from("pinnacle_cached_listings")
    .select("edition_key, character_name, franchise, variant_type, set_name, ask_price, buy_url")
    .ilike("character_name", `%${name}%`)
    .order("ask_price", { ascending: true })
    .limit(perCollection)
  const editionKeys = (rows ?? [])
    .map((r: { edition_key: string }) => r.edition_key)
    .filter(Boolean)
  const keyToFmv = await fetchFmvByEditionKeys(supabase, editionKeys)
  return {
    collection: "Disney Pinnacle",
    collectionId: PINNACLE_COLLECTION_ID,
    results: (rows ?? []).map((r: {
      edition_key: string; character_name: string | null; franchise: string | null;
      variant_type: string | null; set_name: string | null; ask_price: number | null; buy_url: string | null;
    }) => {
      const fmv = keyToFmv.get(r.edition_key) ?? null
      const ask = r.ask_price != null ? Number(r.ask_price) : null
      const discount_pct =
        fmv != null && fmv > 0 && ask != null ? Math.round(((fmv - ask) / fmv) * 100) : null
      return {
        player: r.character_name,
        set: r.set_name ?? r.franchise,
        tier: r.variant_type,
        serial: null,
        price: ask,
        fmv,
        discount_pct,
        buy_url: r.buy_url ?? "",
      }
    }),
  }
}
