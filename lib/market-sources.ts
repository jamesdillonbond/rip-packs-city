import { getEditionMarketMap, type EditionMarketResolved } from "@/lib/edition-market"
import { getExternalEditionMarketMap, type ExternalEditionMarketResolved } from "@/lib/external-market-adapter"
import {
  buildLiveEditionMarketMap,
  type LiveEditionMarketResolved,
  type LiveMarketInputRow,
} from "@/lib/edition-market-live"
import {
  buildEditionScopeKey,
  normalizeParallel,
  normalizeSetName,
} from "@/lib/wallet-normalize"

export type UnifiedMarketInputRow = {
  momentId: string
  editionKey?: string | null
  setName?: string | null
  playerName?: string | null
  parallel?: string | null
  subedition?: string | null
  lowAsk?: number | null
  bestAsk?: number | null
  bestOffer?: number | null
  lastPurchasePrice?: number | null
}

export type UnifiedEditionMarket = {
  scopeKey: string
  lowAsk: number | null
  bestOffer: number | null
  lastSale: number | null
  askCount: number
  offerCount: number
  saleCount: number
  source: string | null
  sourceChain: string[]
  notes: string[]
  tags: string[]
  topshotAsk: number | null
  flowtyAsk: number | null
  fmvUsd: number | null
  fmvConfidence: string | null
  fmvComputedAt: string | null
}

function dedupeStrings(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    )
  )
}

function toLiveRows(rows: UnifiedMarketInputRow[]): LiveMarketInputRow[] {
  return rows.map((row) => ({
    momentId: row.momentId,
    editionKey: row.editionKey ?? null,
    setName: row.setName ?? null,
    playerName: row.playerName ?? null,
    parallel: row.parallel ?? null,
    subedition: row.subedition ?? null,
    lowAsk: row.lowAsk ?? null,
    bestAsk: row.bestAsk ?? null,
    bestOffer: row.bestOffer ?? null,
    lastPurchasePrice: row.lastPurchasePrice ?? null,
  }))
}

function mergeResolvedMarkets(input: {
  scopeKey: string
  live?: LiveEditionMarketResolved | null
  external?: ExternalEditionMarketResolved | null
  graphql?: null  // reserved for future Flowty/OTM feed via RPC_EXTERNAL_MARKET_URL
  seeded?: EditionMarketResolved | null
}): UnifiedEditionMarket {
  const { scopeKey, live, external, seeded } = input

  // Priority: external (Flowty/OTM feed) > live row aggregate > seeded file
  const lowAsk =
    external?.lowAsk ??
    live?.lowAsk ??
    seeded?.lowAsk ??
    null

  const bestOffer =
    external?.bestOffer ??
    live?.bestOffer ??
    seeded?.bestOffer ??
    null

  // Last sale: live aggregate uses lastPurchasePrice from wallet rows
  const lastSale =
    external?.lastSale ??
    seeded?.lastSale ??
    live?.lastSale ??
    null

  const askCount = external?.askCount ?? live?.askCount ?? 0
  const offerCount = external?.offerCount ?? live?.offerCount ?? 0
  const saleCount = external?.saleCount ?? live?.saleCount ?? 0

  const sourceChain = dedupeStrings([
    external?.source ?? null,
    live?.source ?? null,
    seeded?.source ?? null,
  ])

  const notes = dedupeStrings([
    ...(external?.notes ?? []),
    ...(live?.notes ?? []),
    ...(seeded?.notes ?? []),
  ])

  const tags = dedupeStrings([
    ...(external?.tags ?? []),
    ...(live?.tags ?? []),
    ...(seeded?.tags ?? []),
  ])

  return {
    scopeKey,
    lowAsk,
    bestOffer,
    lastSale,
    askCount,
    offerCount,
    saleCount,
    source: sourceChain[0] ?? null,
    sourceChain,
    notes,
    tags,
    topshotAsk: null,
    flowtyAsk: null,
    fmvUsd: null,
    fmvConfidence: null,
    fmvComputedAt: null,
  }
}

/**
 * Fetch market data from Supabase for edition keys that already exist in the DB.
 * This is a supplementary layer — it enriches editions that have been
 * previously indexed, but the primary market data now comes from GraphQL.
 */
async function getSupabaseMarketMap(
  scopeKeys: string[]
): Promise<Map<string, Partial<UnifiedEditionMarket>>> {
  const out = new Map<string, Partial<UnifiedEditionMarket>>()
  for (const key of scopeKeys) {
    out.set(key, {})
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) return out

  try {
    const { createClient } = await import("@supabase/supabase-js")
    const db = createClient(supabaseUrl, supabaseKey)

    // fmv_confidence is a Postgres enum with UPPERCASE values — never use lowercase strings here.
    const { data: fmvRows, error } = await db
      .from("fmv_current")
      .select("edition_id, fmv_usd, floor_price_usd, cross_market_ask, top_shot_ask, flowty_ask, confidence, computed_at")

    if (error || !fmvRows?.length) {
      if (error) console.warn("[market-sources] fmv_current error:", error.message)
      return out
    }

    const editionIds = fmvRows.map((r: { edition_id: string }) => r.edition_id)

    const { data: editions } = await db
      .from("editions")
      .select("id, external_id, parallel_tier")
      .in("id", editionIds)

    if (!editions?.length) return out

    // Build a map from edition_id → { external_id, parallel_tier }
    // parallel_tier should be the normalized parallel string ("Base", "/99", etc.)
    // If your schema doesn't have parallel_tier yet, all rows default to "Base"
    const editionMeta = new Map<string, { externalId: string; parallelTier: string }>()
    for (const ed of editions as Array<{ id: string; external_id: string; parallel_tier?: string }>) {
      editionMeta.set(ed.id, {
        externalId: ed.external_id,
        // Fall back to "Base" if parallel_tier column doesn't exist yet
        parallelTier: ed.parallel_tier ?? "Base",
      })
    }

    for (const row of fmvRows as Array<{
      edition_id: string
      fmv_usd: number | null
      floor_price_usd: number | null
      cross_market_ask: number | null
      top_shot_ask: number | null
      flowty_ask: number | null
      confidence: string | null
      computed_at: string | null
    }>) {
      const meta = editionMeta.get(row.edition_id)
      if (!meta) continue

      // Build the scope key using the actual parallel tier from DB
      const scopeKey = `${meta.externalId}::${meta.parallelTier}`

      if (out.has(scopeKey)) {
        out.set(scopeKey, {
          lowAsk: row.floor_price_usd ?? row.cross_market_ask ?? null,
          lastSale: row.fmv_usd ?? null,
          source: "supabase-fmv",
          topshotAsk: row.top_shot_ask ?? null,
          flowtyAsk: row.flowty_ask ?? null,
          fmvUsd: row.fmv_usd ?? null,
          fmvConfidence: row.confidence ?? null,
          fmvComputedAt: row.computed_at ?? null,
        })
      }
    }
  } catch (e) {
    console.warn(
      "[market-sources] Supabase exception:",
      e instanceof Error ? e.message : e
    )
  }

  return out
}

export async function buildUnifiedEditionMarketMap(rows: UnifiedMarketInputRow[]) {
  // 1. Build live aggregate from the wallet rows themselves (free, synchronous)
  //    This aggregates lowAsk, bestOffer, lastSale per edition from the loaded moments
  const liveMap = buildLiveEditionMarketMap(toLiveRows(rows))

  // 2. Build scope keys for all rows
  const scopeKeys = Array.from(
    new Set(
      rows.map((row) =>
        buildEditionScopeKey({
          editionKey: row.editionKey ?? null,
          setName: normalizeSetName(row.setName ?? null),
          playerName: row.playerName ?? null,
          parallel: normalizeParallel(row.parallel ?? row.subedition ?? ""),
          subedition: normalizeParallel(row.subedition ?? row.parallel ?? ""),
        })
      )
    )
  )

  // 3. Fetch static/external sources in parallel (no rate-limited API calls)
  //    GraphQL market data is available via RPC_EXTERNAL_MARKET_URL env var
  //    when a Flowty/OTM partnership feed is configured.
  const [externalMap, seededMap, supabaseMap] = await Promise.all([
    getExternalEditionMarketMap(),
    getEditionMarketMap(),
    getSupabaseMarketMap(scopeKeys),
  ])

  // 4. Merge all sources for each scope key
  const out = new Map<string, UnifiedEditionMarket>()

  for (const scopeKey of scopeKeys) {
    const supabaseData = supabaseMap.get(scopeKey)
    const hasSupabaseData =
      supabaseData && (supabaseData.lowAsk != null || supabaseData.lastSale != null)

    const merged = mergeResolvedMarkets({
      scopeKey,
      live: liveMap.get(scopeKey) ?? null,
      external: externalMap.get(scopeKey) ?? null,
      graphql: null,
      seeded: seededMap.get(scopeKey) ?? null,
    })

    // Layer in Supabase data where live/external have no signal
    if (hasSupabaseData) {
      if (merged.lowAsk === null && supabaseData.lowAsk != null) {
        merged.lowAsk = supabaseData.lowAsk
        merged.source = "supabase-fmv"
        merged.sourceChain = ["supabase-fmv", ...merged.sourceChain]
      }
      if (merged.lastSale === null && supabaseData.lastSale != null) {
        merged.lastSale = supabaseData.lastSale
      }
      // Always carry through Supabase FMV-specific fields
      merged.topshotAsk = supabaseData.topshotAsk ?? null
      merged.flowtyAsk = supabaseData.flowtyAsk ?? null
      merged.fmvUsd = supabaseData.fmvUsd ?? null
      merged.fmvConfidence = supabaseData.fmvConfidence ?? null
      merged.fmvComputedAt = supabaseData.fmvComputedAt ?? null
    }

    out.set(scopeKey, merged)
  }

  return out
}