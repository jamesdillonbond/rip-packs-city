import { NextRequest, NextResponse } from "next/server"
import { topshotGraphql } from "@/lib/topshot"
import { supabaseAdmin } from "@/lib/supabase"

// Server-side port of scripts/topshot-badge-sync.js.
// POST: run the full sweep cycle (Rookie Year / TS Debut / ROTY / Champ Year
// in parallel, then Rookie Mint as a setplay sweep) and upsert to badge_editions.
// GET:  read-only — badge_editions count grouped by collection_id.

// Full badge sweeps walk thousands of editions per badge (TS Debut / Rookie
// Year span all of TS history), so the route needs headroom past Vercel's
// default function timeout. 300s is well under the Pro 800s hard cap.
export const maxDuration = 300
export const dynamic = "force-dynamic"

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
// Headroom, not a forced walk: sweep() breaks naturally on null/repeat cursor
// or a short page, so each badge stops at its true end. TS Debut / Rookie Year
// span the full history (thousands of editions) and were truncated at the old
// 20-page (2,000-edition) cap, starving older Series 1-4 classics of badge rows.
const MAX_PAGES = 80
const BATCH_SIZE = 50
const PAGE_DELAY_MS = 250
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
                set { id flowId flowName flowSeriesNumber }
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

// Catalog-walk query (audit 2026-06-09): the tag-filtered sweeps above only
// collect editions that carry one of the 5 badge tags, so the ~66% of canonical
// editions with no rookie/champ tag (veterans' base moments etc.) never got a
// badge_editions row — no circulation/effective_supply, no burn truth, "no
// badge data". This empty-filter sweep (`filters: {}`, the topshot-fmv-populate-
// proven shape that returns the full catalog, not just tag matches) walks every
// edition so all of them get circulations + whatever real badges they have.
// Cursored across runs via backfill_state so it sweeps the full catalog over
// several daily ticks; the tag sweeps stay as the freshness layer.
const CATALOG_QUERY = `
  query BadgeCatalogSweep(
    $searchInput: BaseSearchInput = {pagination: {direction: RIGHT, limit: 100, cursor: ""}}
  ) {
    searchMarketplaceEditions(input: {
      filters: {}
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
                set { id flowId flowName flowSeriesNumber }
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
              }
            }
          }
        }
      }
    }
  }
`

const CATALOG_SWEEP_ID = "topshot-badge-catalog"
const CATALOG_PIPELINE = "topshot-badge-catalog"
const CATALOG_MAX_PAGES = 250 // ~25k editions/run; time budget usually stops first
const CATALOG_TIME_OVERHEAD_MS = 45_000

type Tag = { id: string; title: string; visible: boolean; level?: string }
type RawEdition = {
  id: string
  assetPathPrefix: string | null
  tier: string | null
  parallelID: number | null
  parallelName: string | null
  set: { id: string; flowId: string | number | null; flowName: string; flowSeriesNumber: number | null } | null
  play: {
    id: string; flowID: string | number | null
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

function intLike(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  // "0" is Top Shot's "unset" sentinel for flowId on searchMarketplaceEditions
  // (e.g. Run It Back: Origins returns set.flowId=0), NOT a real on-chain id —
  // set/play on-chain ids start at 1. Reject it so we fall back to the sets map.
  if (!/^\d+$/.test(s) || s === "0") return null
  return s
}

// Canonical edition key = the on-chain integer pair "setIDonchain:playIDonchain"
// (== editions.external_id, what get_edition_badges_unified joins on).
// searchMarketplaceEditions returns set.id / play.id as GQL UUIDs for most
// editions, so the old `${set.id}:${play.id}` key produced UUID-pair keys that
// NEVER joined a canonical integer edition — badges invisible. Prefer the
// integer fields (set.flowId / play.flowID), fall back to an already-integer id
// (some editions return integers there), then to the sets-table
// UUID -> set_id_onchain map. A row that can't yield an integer pair is SKIPPED
// (a UUID-keyed badge row is useless — it can never join).
function editionKey(e: RawEdition, setMap: Map<string, string>): string | null {
  const playStr = intLike(e.play?.flowID) ?? intLike(e.play?.id)
  // Prefer the authoritative sets-table set_id_onchain (keyed by the GQL set
  // UUID): set.flowId is unreliable here (returns the 0 sentinel for many
  // classics, which would mis-key them as "0:<play>" and never join). flowId /
  // an already-integer id are fallbacks for the ~14 sets the map doesn't cover.
  let setStr: string | null = e.set?.id ? (setMap.get(e.set.id) ?? null) : null
  if (!setStr) setStr = intLike(e.set?.flowId) ?? intLike(e.set?.id)
  if (!setStr || !playStr) return null
  return `${setStr}:${playStr}`
}

// Sets table is the authoritative UUID -> set_id_onchain bridge for the cases
// where the GQL set.flowId comes back null (240/254 TS sets carry it).
async function fetchSetOnchainMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const { data, error } = await (supabaseAdmin as any)
    .from("sets")
    .select("external_id, set_id_onchain")
    .eq("collection_id", COLLECTION_ID)
    .not("set_id_onchain", "is", null)
    .limit(10000)
  if (error) {
    console.log("[badge-sync] set onchain map error:", error.message)
    return map
  }
  for (const r of (data as Array<{ external_id: string | null; set_id_onchain: number | null }> | null) ?? []) {
    if (r.external_id && r.set_id_onchain != null) map.set(r.external_id, String(r.set_id_onchain))
  }
  return map
}

// Merge an edition's (parallel's) play/setPlay tags into an existing row.
// Badges are play-level (identical across parallels) so union-by-id is lossless;
// this collapses all parallels of a play into the single per-play row that the
// (external_id, collection_id) grain demands.
function mergeTags(existing: BadgeRow, e: RawEdition) {
  const incomingPlay = (e.play?.tags ?? [])
    .filter((t) => t.visible && t.id !== BADGE.INTERACTIVE)
    .map((t) => ({ id: t.id, title: t.title }))
  const incomingSetPlay = (e.setPlay?.tags ?? [])
    .filter((t) => t.visible && t.id !== BADGE.INTERACTIVE)
    .map((t) => ({ id: t.id, title: t.title }))
  const pIds = new Set(existing.play_tags.map((t) => t.id))
  for (const t of incomingPlay) if (!pIds.has(t.id)) { existing.play_tags.push(t); pIds.add(t.id) }
  const sIds = new Set(existing.set_play_tags.map((t) => t.id))
  for (const t of incomingSetPlay) if (!sIds.has(t.id)) { existing.set_play_tags.push(t); sIds.add(t.id) }
  if (sIds.has(BADGE.ROOKIE_MINT)) existing.has_rookie_mint = true
  existing.is_three_star_rookie =
    pIds.has(BADGE.ROOKIE_YEAR) && pIds.has(BADGE.ROOKIE_PREMIERE) && pIds.has(BADGE.TOP_SHOT_DEBUT)
  existing.badge_score = computeBadgeScore(pIds, sIds)
}

function normalizeEdition(e: RawEdition, externalId: string | null): BadgeRow {
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

  return {
    id: e.id,
    collection_id: COLLECTION_ID,
    external_id: externalId,
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

async function fetchCatalogPage(
  cursor: string,
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
  const data = await topshotGraphql<GqlShape>(CATALOG_QUERY, {
    searchInput: { pagination: { direction: "RIGHT", limit: PAGE_LIMIT, cursor } },
  })
  const summary = data?.searchMarketplaceEditions?.data?.searchSummary
  return {
    editions: summary?.data?.data ?? [],
    nextCursor: summary?.pagination?.rightCursor ?? null,
    total: summary?.data?.size ?? 0,
  }
}

// Cursored full-catalog badge/circulation sweep. Walks every edition (not just
// tag matches), persisting the GQL cursor in backfill_state so a partial run
// resumes cleanly and the cursor wraps to "" at feed end (continuous refresh).
async function runCatalogSweep(): Promise<NextResponse> {
  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  const supabase: any = supabaseAdmin
  const timeBudgetMs = maxDuration * 1000 - CATALOG_TIME_OVERHEAD_MS

  const setMap = await fetchSetOnchainMap()

  // Resume cursor.
  let cursor = ""
  try {
    const { data: state } = await supabase
      .from("backfill_state")
      .select("cursor")
      .eq("id", CATALOG_SWEEP_ID)
      .maybeSingle()
    cursor = (state?.cursor ?? "") || ""
  } catch {
    cursor = ""
  }
  const cursorBefore = cursor

  const all = new Map<string, BadgeRow>()
  const keyedIds = new Set<string>()
  const seenCursors = new Set<string>()
  let pagesFetched = 0
  let nodesFetched = 0
  let skippedNoKey = 0
  let sweepComplete = false
  let terminatedReason = "time_budget_exceeded"
  let gqlError: string | null = null

  function ingest(e: RawEdition) {
    const key = editionKey(e, setMap)
    if (!key) { skippedNoKey++; return }
    if (e.id) keyedIds.add(e.id)
    const existing = all.get(key)
    if (existing) mergeTags(existing, e)
    else all.set(key, normalizeEdition(e, key))
  }

  for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
    if (Date.now() - startedAt > timeBudgetMs) {
      terminatedReason = "time_budget_exceeded"
      break
    }
    try {
      const { editions, nextCursor } = await fetchCatalogPage(cursor)
      pagesFetched++
      nodesFetched += editions.length
      for (const e of editions) ingest(e)
      if (!nextCursor || editions.length === 0 || nextCursor === cursor || seenCursors.has(nextCursor)) {
        sweepComplete = true
        terminatedReason = "feed_exhausted"
        break
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
    } catch (err) {
      gqlError = err instanceof Error ? err.message : String(err)
      terminatedReason = "gql_error"
      break
    }
    await sleep(PAGE_DELAY_MS)
  }

  const rows = Array.from(all.values())

  // Same re-key-safe write path as the tag sweep: free the PK for editions we
  // re-keyed this run, then upsert on (external_id, collection_id).
  let deletedStaleRows = 0
  const keyedIdList = Array.from(keyedIds)
  for (let i = 0; i < keyedIdList.length; i += 150) {
    const idChunk = keyedIdList.slice(i, i + 150)
    const { count, error } = await supabase
      .from("badge_editions")
      .delete({ count: "exact" })
      .eq("collection_id", COLLECTION_ID)
      .in("id", idChunk)
    if (error) console.log(`[badge-sync] catalog stale-row delete chunk ${i} error:`, error.message)
    else deletedStaleRows += count ?? 0
  }

  let upserted = 0
  let upsertErrors = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from("badge_editions")
      .upsert(batch, { onConflict: "external_id,collection_id" })
    if (error) {
      console.log(`[badge-sync] catalog upsert batch ${i} error:`, error.message)
      upsertErrors++
    } else {
      upserted += batch.length
    }
    if (i + BATCH_SIZE < rows.length) await sleep(BATCH_DELAY_MS)
  }

  // Persist cursor (wrap to "" at feed end so the sweep restarts next run).
  const nextCursor = sweepComplete ? "" : cursor
  try {
    await supabase
      .from("backfill_state")
      .upsert(
        { id: CATALOG_SWEEP_ID, cursor: nextCursor, status: sweepComplete ? "complete" : "pending", last_run_at: new Date().toISOString() },
        { onConflict: "id" },
      )
  } catch (e) {
    console.log(`[badge-sync] catalog cursor update failed: ${e instanceof Error ? e.message : e}`)
  }

  const durationMs = Date.now() - startedAt
  const ok = gqlError === null && upsertErrors === 0
  try {
    await supabase.from("pipeline_runs").insert({
      pipeline: CATALOG_PIPELINE,
      collection_slug: "nba_top_shot",
      started_at: startedAtIso,
      finished_at: new Date().toISOString(),
      rows_found: nodesFetched,
      rows_written: upserted,
      rows_skipped: skippedNoKey,
      ok,
      error: gqlError,
      cursor_before: cursorBefore || null,
      cursor_after: nextCursor || null,
      extra: {
        pages_fetched: pagesFetched,
        nodes_fetched: nodesFetched,
        distinct_editions: rows.length,
        upserted,
        upsert_errors: upsertErrors,
        deleted_stale_rows: deletedStaleRows,
        skipped_no_key: skippedNoKey,
        sweep_complete: sweepComplete,
        terminated_reason: terminatedReason,
        duration_ms: durationMs,
      },
    })
  } catch {
    // best-effort
  }

  return NextResponse.json({
    ok,
    mode: "catalog",
    pipeline: CATALOG_PIPELINE,
    pagesFetched,
    nodesFetched,
    distinctEditions: rows.length,
    upserted,
    upsertErrors,
    deletedStaleRows,
    skippedNoKey,
    sweepComplete,
    terminatedReason,
    cursorBefore: cursorBefore || null,
    cursorAfter: nextCursor || null,
    durationMs,
  })
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  if (!process.env.INGEST_SECRET_TOKEN || bearer !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Catalog-walk mode (?mode=catalog): cursored full-catalog badge/circulation
  // sweep. Separate from the default tag sweeps so it doesn't blow the time
  // budget; operator wires its own cron-job.org entry.
  if (req.nextUrl.searchParams.get("mode") === "catalog") {
    return runCatalogSweep()
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

  // UUID -> set_id_onchain bridge for editions whose GQL set.flowId is null.
  const setMap = await fetchSetOnchainMap()

  // Dedupe by the canonical integer pair (one row per play, badges union across
  // parallels), NOT by the per-parallel GQL e.id. Rows that can't form an
  // integer pair are skipped (a UUID-keyed badge row never joins).
  const all = new Map<string, BadgeRow>()
  const keyedIds = new Set<string>() // every parallel id that produced a valid integer key
  let skippedNoKey = 0

  function ingest(e: RawEdition) {
    const key = editionKey(e, setMap)
    if (!key) { skippedNoKey++; return }
    if (e.id) keyedIds.add(e.id)
    const existing = all.get(key)
    if (existing) mergeTags(existing, e)
    else all.set(key, normalizeEdition(e, key))
  }

  for (const group of [rookieYear, tsDebut, roty, champYear, rookieMint]) {
    for (const e of group) ingest(e)
  }

  const rows = Array.from(all.values())

  // Free the PK before upserting: a table row for one of these editions may
  // carry the same id (e.id) as the integer row we're about to write but a
  // different external_id (old UUID-pair key, or a bogus "0:<play>" key from a
  // flowId=0 sentinel), so a plain onConflict:(external_id,collection_id) insert
  // would PK-collide. Delete every existing row for editions we RE-KEYED this
  // sweep (id in keyedIds) — each has a fresh replacement in `rows`, so no badge
  // is dropped without a correctly-keyed copy taking its place. Editions we
  // skipped (no integer key) keep their existing row untouched.
  let deletedStaleRows = 0
  const keyedIdList = Array.from(keyedIds)
  for (let i = 0; i < keyedIdList.length; i += 150) {
    const idChunk = keyedIdList.slice(i, i + 150)
    const { count, error } = await (supabaseAdmin as any)
      .from("badge_editions")
      .delete({ count: "exact" })
      .eq("collection_id", COLLECTION_ID)
      .in("id", idChunk)
    if (error) console.log(`[badge-sync] stale-row delete chunk ${i} error:`, error.message)
    else deletedStaleRows += count ?? 0
  }

  let upserted = 0
  let upsertErrors = 0

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await (supabaseAdmin as any)
      .from("badge_editions")
      .upsert(batch, { onConflict: "external_id,collection_id" })
    if (error) {
      console.log(`[badge-sync] upsert batch ${i} error:`, error.message)
      upsertErrors++
    } else {
      upserted += batch.length
    }
    if (i + BATCH_SIZE < rows.length) await sleep(BATCH_DELAY_MS)
  }

  // Refresh Golazos badges via its seed endpoint (pattern-based classification
  // over editions.set_name — no GQL sweep required).
  // NFL All Day badges are NO LONGER seeded here: seed-allday-badges was a
  // set-name heuristic that smeared one guess across moments that differ. Real
  // per-moment AllDay badges now come from the residential Atlas
  // EditionService ingest (/api/cron/allday-badge-ingest, driven by
  // scripts/ingest-allday-badges.mjs). Re-adding seed-allday-badges here would
  // clobber those real badges with the heuristic on every TS badge-sync tick.
  const baseUrl = req.nextUrl.origin
  const token = process.env.INGEST_SECRET_TOKEN ?? ""
  const seedResults: Record<string, unknown> = {}
  for (const slug of ["seed-golazos-badges"] as const) {
    try {
      const res = await fetch(`${baseUrl}/api/${slug}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
      seedResults[slug] = res.ok ? await res.json() : { status: res.status }
    } catch (err) {
      seedResults[slug] = { error: err instanceof Error ? err.message : String(err) }
    }
  }

  return NextResponse.json({
    ok: true,
    collected: rows.length,
    upserted,
    upsertErrors,
    skippedNoKey,
    deletedStaleRows,
    sweepCounts,
    seedResults,
    durationMs: Date.now() - startedAt,
  })
}

export async function GET() {
  const { data, error } = await (supabaseAdmin as any).rpc("badge_editions_counts")
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  const counts: Record<string, number> = {}
  let total = 0
  for (const row of (data as Array<{ collection_id: string | null; count: number | string }> | null) ?? []) {
    const k = row.collection_id ?? "null"
    const n = Number(row.count) || 0
    counts[k] = n
    total += n
  }
  return NextResponse.json({ counts, total })
}
