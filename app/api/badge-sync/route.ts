import { NextRequest, NextResponse } from "next/server"
import { topshotGraphql } from "@/lib/topshot"
import { supabaseAdmin } from "@/lib/supabase"

// Server-side port of scripts/topshot-badge-sync.js.
// POST: run the full sweep cycle (Rookie Year / TS Debut / ROTY / Champ Year
// in parallel, then Rookie Mint as a setplay sweep) and upsert to badge_editions.
// GET:  read-only — badge_editions count grouped by collection_id.

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const BADGE = {
  ROOKIE_YEAR:        "2dbd4eef-4417-451b-b645-90f02574a401",
  ROOKIE_PREMIERE:    "0ddb2c58-4385-443b-9c70-239b32cddbd4",
  TOP_SHOT_DEBUT:     "a75e247a-ecbf-45a6-b1be-58bb07a1b651",
  ROOKIE_OF_THE_YEAR: "34fe8d3f-681a-42df-856a-e98624f95b11",
  ROOKIE_MINT:        "24d515af-e967-45f5-a30e-11fc96dc2b62",
  CHAMPIONSHIP_YEAR:  "f197f60a-b502-4386-b0c0-7f4cde8164ff",
  INTERACTIVE:        "9bbb6f91-d09a-4d07-ab3d-8402a9c10cf1",
} as const

const PAGE_LIMIT = 100
const MAX_PAGES = 20
const BATCH_SIZE = 50
const PAGE_DELAY_MS = 400
const BATCH_DELAY_MS = 150

const QUERY = `
  query SearchMarketplaceEditions(
    $byPlayTagIDs: [ID] = []
    $bySetPlayTagIDs: [ID] = []
    $searchInput: BaseSearchInput = {pagination: {direction: RIGHT, limit: 100, cursor: ""}}
  ) {
    searchMarketplaceEditions(input: {
      filters: { byPlayTagIDs: $byPlayTagIDs, bySetPlayTagIDs: $bySetPlayTagIDs }
      sortBy: EDITION_CREATED_AT_DESC
      searchInput: $searchInput
    }) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            size
            data {
              ... on MarketplaceEdition {
                id
                assetPathPrefix
                tier
                parallelID
                parallelName
                set { id flowName flowSeriesNumber }
                play {
                  id flowID
                  stats {
                    playerName firstName lastName
                    teamAtMoment teamAtMomentNbaId
                    nbaSeason jerseyNumber playerID
                    playCategory dateOfMoment
                  }
                  tags { id title visible level }
                }
                setPlay {
                  ID flowRetired
                  tags { id title visible level }
                  circulations {
                    burned circulationCount forSaleByCollectors
                    hiddenInPacks ownedByCollectors locked effectiveSupply
                  }
                }
                lowAsk highestOffer
                circulationCount effectiveSupply burned locked owned hiddenInPacks
                averageSaleData { averagePrice numDays numSales }
                marketplaceStats {
                  price averageSalePrice
                  change24h change7d change30d
                  volume24h volume7d volume30d
                }
              }
            }
          }
        }
      }
    }
  }
`

type Tag = { id: string; title: string; visible: boolean; level?: string }
type RawEdition = {
  id: string
  assetPathPrefix: string | null
  tier: string | null
  parallelID: number | null
  parallelName: string | null
  set: { id: string; flowName: string; flowSeriesNumber: number | null } | null
  play: {
    id: string; flowID: string | null
    stats: {
      playerName: string | null; firstName: string | null; lastName: string | null
      teamAtMoment: string | null; teamAtMomentNbaId: string | null
      nbaSeason: string | null; jerseyNumber: number | null; playerID: string | null
      playCategory: string | null; dateOfMoment: string | null
    } | null
    tags: Tag[] | null
  } | null
  setPlay: {
    ID: string; flowRetired: boolean
    tags: Tag[] | null
    circulations: {
      burned: number | null; circulationCount: number | null; forSaleByCollectors: number | null
      hiddenInPacks: number | null; ownedByCollectors: number | null
      locked: number | null; effectiveSupply: number | null
    } | null
  } | null
  lowAsk: number | null
  highestOffer: number | null
  averageSaleData: { averagePrice: string | null } | null
  circulationCount: number | null
  effectiveSupply: number | null
  burned: number | null
  locked: number | null
  owned: number | null
  hiddenInPacks: number | null
}

type BadgeRow = {
  id: string
  collection_id: string
  external_id: string | null
  set_id: string | null
  play_id: string | null
  player_id: string | null
  player_name: string | null
  team: string | null
  team_nba_id: string | null
  season: string | null
  set_name: string | null
  series_number: number | null
  tier: string | null
  parallel_id: number
  parallel_name: string
  play_tags: Array<{ id: string; title: string }>
  set_play_tags: Array<{ id: string; title: string }>
  is_three_star_rookie: boolean
  has_rookie_mint: boolean
  badge_score: number
  low_ask: number | null
  highest_offer: number | null
  avg_sale_price: number | null
  circulation_count: number
  effective_supply: number | null
  burned: number
  locked: number
  owned: number
  hidden_in_packs: number | null
  burn_rate_pct: number
  lock_rate_pct: number
  flow_retired: boolean
  asset_path_prefix: string | null
  updated_at: string
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function computeBadgeScore(
  playTagIds: Set<string>,
  setPlayTagIds: Set<string>
): number {
  let score = 0
  if (playTagIds.has(BADGE.ROOKIE_YEAR)) score += 1
  if (playTagIds.has(BADGE.ROOKIE_PREMIERE)) score += 1
  if (playTagIds.has(BADGE.TOP_SHOT_DEBUT)) score += 1
  if (setPlayTagIds.has(BADGE.ROOKIE_MINT)) score += 1
  const isThreeStar =
    playTagIds.has(BADGE.ROOKIE_YEAR) &&
    playTagIds.has(BADGE.ROOKIE_PREMIERE) &&
    playTagIds.has(BADGE.TOP_SHOT_DEBUT)
  if (isThreeStar && setPlayTagIds.has(BADGE.ROOKIE_MINT)) score += 4
  if (playTagIds.has(BADGE.ROOKIE_OF_THE_YEAR)) score += 3
  if (playTagIds.has(BADGE.CHAMPIONSHIP_YEAR)) score += 2
  return score
}

function normalizeEdition(e: RawEdition): BadgeRow {
  const playTags = (e.play?.tags ?? [])
    .filter((t) => t.visible && t.id !== BADGE.INTERACTIVE)
    .map((t) => ({ id: t.id, title: t.title }))
  const setPlayTags = (e.setPlay?.tags ?? [])
    .filter((t) => t.visible && t.id !== BADGE.INTERACTIVE)
    .map((t) => ({ id: t.id, title: t.title }))
  const pIds = new Set(playTags.map((t) => t.id))
  const sIds = new Set(setPlayTags.map((t) => t.id))
  const circ = e.setPlay?.circulations ?? null
  const totalCirc = circ?.circulationCount ?? 0
  const burned = circ?.burned ?? 0
  const locked = circ?.locked ?? 0
  const owned = circ?.ownedByCollectors ?? 0
  const set_id = e.set?.id ?? null
  const play_id = e.play?.id ?? null
  const external_id = set_id && play_id ? `${set_id}:${play_id}` : null

  return {
    id: e.id,
    collection_id: COLLECTION_ID,
    external_id,
    set_id,
    play_id,
    player_id: e.play?.stats?.playerID ?? null,
    player_name: e.play?.stats?.playerName ?? null,
    team: e.play?.stats?.teamAtMoment ?? null,
    team_nba_id: e.play?.stats?.teamAtMomentNbaId ?? null,
    season: e.play?.stats?.nbaSeason ?? null,
    set_name: e.set?.flowName ?? null,
    series_number: e.set?.flowSeriesNumber ?? null,
    tier: e.tier ?? null,
    parallel_id: e.parallelID ?? 0,
    parallel_name: e.parallelName ?? "Standard",
    play_tags: playTags,
    set_play_tags: setPlayTags,
    is_three_star_rookie:
      pIds.has(BADGE.ROOKIE_YEAR) &&
      pIds.has(BADGE.ROOKIE_PREMIERE) &&
      pIds.has(BADGE.TOP_SHOT_DEBUT),
    has_rookie_mint: sIds.has(BADGE.ROOKIE_MINT),
    badge_score: computeBadgeScore(pIds, sIds),
    low_ask: e.lowAsk ?? null,
    highest_offer: e.highestOffer ?? null,
    avg_sale_price: parseFloat(e.averageSaleData?.averagePrice ?? "0") || null,
    circulation_count: totalCirc,
    effective_supply: circ?.effectiveSupply ?? null,
    burned,
    locked,
    owned,
    hidden_in_packs: circ?.hiddenInPacks ?? null,
    burn_rate_pct: totalCirc > 0 ? parseFloat(((burned / totalCirc) * 100).toFixed(1)) : 0,
    lock_rate_pct: owned > 0 ? parseFloat(((locked / owned) * 100).toFixed(1)) : 0,
    flow_retired: e.setPlay?.flowRetired ?? false,
    asset_path_prefix: e.assetPathPrefix ?? null,
    updated_at: new Date().toISOString(),
  }
}

async function fetchPage(
  playTagIDs: string[],
  setPlayTagIDs: string[],
  cursor: string
): Promise<{ editions: RawEdition[]; nextCursor: string | null; total: number }> {
  type GqlShape = {
    searchMarketplaceEditions: {
      data: {
        searchSummary: {
          pagination: { rightCursor: string | null }
          data: { size: number; data: RawEdition[] }
        }
      }
    }
  }
  const data = await topshotGraphql<GqlShape>(QUERY, {
    byPlayTagIDs: playTagIDs,
    bySetPlayTagIDs: setPlayTagIDs,
    searchInput: { pagination: { direction: "RIGHT", limit: PAGE_LIMIT, cursor } },
  })
  const summary = data?.searchMarketplaceEditions?.data?.searchSummary
  return {
    editions: summary?.data?.data ?? [],
    nextCursor: summary?.pagination?.rightCursor ?? null,
    total: summary?.data?.size ?? 0,
  }
}

async function sweep(
  label: string,
  playTagIDs: string[],
  setPlayTagIDs: string[] = []
): Promise<RawEdition[]> {
  const collected: RawEdition[] = []
  const seen = new Set<string>()
  let cursor = ""
  let page = 0

  while (page < MAX_PAGES) {
    if (cursor && seen.has(cursor)) break
    if (cursor) seen.add(cursor)

    try {
      const { editions, nextCursor } = await fetchPage(playTagIDs, setPlayTagIDs, cursor)
      page++
      collected.push(...editions)
      if (!nextCursor || editions.length < PAGE_LIMIT || nextCursor === cursor) break
      cursor = nextCursor
    } catch (err) {
      console.log(
        `[badge-sync] ${label} page ${page + 1} fetch error:`,
        err instanceof Error ? err.message : String(err)
      )
      break
    }
    await sleep(PAGE_DELAY_MS)
  }

  console.log(`[badge-sync] sweep "${label}": ${collected.length} editions across ${page} pages`)
  return collected
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  if (!process.env.INGEST_SECRET_TOKEN || bearer !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = Date.now()

  // Play-level sweeps in parallel
  const [rookieYear, tsDebut, roty, champYear] = await Promise.all([
    sweep("Rookie Year",       [BADGE.ROOKIE_YEAR]),
    sweep("Top Shot Debut",    [BADGE.TOP_SHOT_DEBUT]),
    sweep("ROTY",              [BADGE.ROOKIE_OF_THE_YEAR]),
    sweep("Championship Year", [BADGE.CHAMPIONSHIP_YEAR]),
  ])

  // Rookie Mint is a setplay-level sweep — run last, merge-only
  const rookieMint = await sweep("Rookie Mint", [], [BADGE.ROOKIE_MINT])

  const sweepCounts: Record<string, number> = {
    "Rookie Year": rookieYear.length,
    "Top Shot Debut": tsDebut.length,
    "ROTY": roty.length,
    "Championship Year": champYear.length,
    "Rookie Mint": rookieMint.length,
  }

  const all = new Map<string, BadgeRow>()
  for (const group of [rookieYear, tsDebut, roty, champYear]) {
    for (const e of group) {
      if (!all.has(e.id)) all.set(e.id, normalizeEdition(e))
    }
  }

  // Rookie Mint merge: attach set_play_tags + recompute score if edition exists
  for (const e of rookieMint) {
    const incomingSetPlayTags = (e.setPlay?.tags ?? [])
      .filter((t) => t.visible && t.id !== BADGE.INTERACTIVE)
      .map((t) => ({ id: t.id, title: t.title }))

    const existing = all.get(e.id)
    if (existing) {
      const existingIds = new Set(existing.set_play_tags.map((t) => t.id))
      for (const t of incomingSetPlayTags) {
        if (!existingIds.has(t.id)) {
          existing.set_play_tags.push(t)
          existingIds.add(t.id)
        }
      }
      if (incomingSetPlayTags.some((t) => t.id === BADGE.ROOKIE_MINT)) {
        existing.has_rookie_mint = true
      }
      const pIds = new Set(existing.play_tags.map((t) => t.id))
      existing.badge_score = computeBadgeScore(pIds, existingIds)
    } else {
      all.set(e.id, normalizeEdition(e))
    }
  }

  const rows = Array.from(all.values())
  let upserted = 0
  let upsertErrors = 0

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await (supabaseAdmin as any)
      .from("badge_editions")
      .upsert(batch, { onConflict: "id" })
    if (error) {
      console.log(`[badge-sync] upsert batch ${i} error:`, error.message)
      upsertErrors++
    } else {
      upserted += batch.length
    }
    if (i + BATCH_SIZE < rows.length) await sleep(BATCH_DELAY_MS)
  }

  return NextResponse.json({
    ok: true,
    collected: rows.length,
    upserted,
    upsertErrors,
    sweepCounts,
    durationMs: Date.now() - startedAt,
  })
}

export async function GET() {
  const { data, error } = await (supabaseAdmin as any)
    .from("badge_editions")
    .select("collection_id")
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  const counts: Record<string, number> = {}
  for (const row of (data as Array<{ collection_id: string | null }> | null) ?? []) {
    const k = row.collection_id ?? "null"
    counts[k] = (counts[k] ?? 0) + 1
  }
  return NextResponse.json({ counts, total: (data?.length ?? 0) })
}
