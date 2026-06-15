import { NextRequest, NextResponse } from "next/server"
import { topshotGraphql } from "@/lib/topshot"
import { supabaseAdmin } from "@/lib/supabase"

// Backfill badge_editions rows for the ~199 canonical Top Shot editions that
// the catalog badge-sweep (searchMarketplaceEditions) structurally misses —
// rare/Ultimate "trophy" editions (Supernova, Skyline, Kingmaker, Honors, …)
// that aren't surfaced by the marketplace search, so get_edition_badges_unified
// returns [] and they show no badges anywhere (KD's Supernova trophy etc.).
//
// Path: searchEditions(filters:{bySetIDs:[<setUUID>]}) returns the FULL catalog
// for a set (not just marketplace-listed editions), including play.tags /
// setPlay.tags — the same shape badge-sync normalizes. We already hold the
// set on-chain-int -> GQL-UUID bridge (sets.external_id, plus sibling
// badge_editions.set_id rows), so one query per set yields every edition's
// badges. We write ONLY editions that currently have no badge_editions row, so
// the run is purely additive (no re-key/delete of existing rows).
//
// Modes (POST, Bearer INGEST_SECRET_TOKEN):
//   ?dryRun=1        compute rows, return a summary + KD sample, write nothing
//   ?set=<intId>     restrict to a single on-chain set id (probe a set in isolation)
//
// Editions whose set has no recoverable GQL UUID (7 sets / ~45 editions) are
// reported as unreachableNoSetUuid — they need the getMintedMoment(moment_id)
// fallback (a follow-up pass), not this route.
export const maxDuration = 300
export const dynamic = "force-dynamic"

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const COLLECTION_SLUG = "nba_top_shot"
const PIPELINE = "topshot-badge-set-backfill"

const BADGE = {
  ROOKIE_YEAR:        "2dbd4eef-4417-451b-b645-90f02574a401",
  ROOKIE_PREMIERE:    "0ddb2c58-4385-443b-9c70-239b32cddbd4",
  TOP_SHOT_DEBUT:     "a75e247a-ecbf-45a6-b1be-58bb07a1b651",
  ROOKIE_OF_THE_YEAR: "34fe8d3f-681a-42df-856a-e98624f95b11",
  ROOKIE_MINT:        "24d515af-e967-45f5-a30e-11fc96dc2b62",
  CHAMPIONSHIP_YEAR:  "f197f60a-b502-4386-b0c0-7f4cde8164ff",
  INTERACTIVE:        "9bbb6f91-d09a-4d07-ab3d-8402a9c10cf1",
} as const

const PAGE_LIMIT = 500 // sets are < 500 editions; one page each in practice
const SET_DELAY_MS = 200
const BATCH_SIZE = 50
const BATCH_DELAY_MS = 150
const TIME_OVERHEAD_MS = 30_000

// searchEditions returns the Edition type (not MarketplaceEdition). Request only
// fields the Edition type is known to expose from the two existing backfill
// scripts (id, set{flowId}, play{flowID stats}, tier) plus the tag/circulation
// fields we need. If the live schema rejects a field the dryRun surfaces it in
// `gqlError` and we trim — start conservative, the probe tells us the truth.
const QUERY = `
  query BadgeBySetBackfill($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
        data {
          ... on Editions {
            data {
              ... on Edition {
                id
                tier
                parallelID
                parallelName
                set { id flowId flowName flowSeriesNumber }
                play {
                  id flowID
                  stats {
                    playerName teamAtMoment teamAtMomentNbaId nbaSeason playerID
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
                circulationCount
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
  tier: string | null
  parallelID: number | null
  parallelName: string | null
  set: { id: string; flowId: string | number | null; flowName: string | null; flowSeriesNumber: number | null } | null
  play: {
    id: string; flowID: string | number | null
    stats: {
      playerName: string | null; teamAtMoment: string | null; teamAtMomentNbaId: string | null
      nbaSeason: string | null; playerID: string | null
    } | null
    tags: Tag[] | null
  } | null
  setPlay: {
    ID: string; flowRetired: boolean | null
    tags: Tag[] | null
    circulations: {
      burned: number | null; circulationCount: number | null; forSaleByCollectors: number | null
      hiddenInPacks: number | null; ownedByCollectors: number | null
      locked: number | null; effectiveSupply: number | null
    } | null
  } | null
  circulationCount: number | null
}

type BadgeRow = {
  id: string
  collection_id: string
  collection: string
  external_id: string
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
  circulation_count: number
  effective_supply: number | null
  burned: number
  locked: number
  owned: number
  hidden_in_packs: number | null
  burn_rate_pct: number
  lock_rate_pct: number
  flow_retired: boolean
  updated_at: string
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function computeBadgeScore(playTagIds: Set<string>, setPlayTagIds: Set<string>): number {
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
  if (!/^\d+$/.test(s) || s === "0") return null
  return s
}

// Canonical edition key = "setIDonchain:playIDonchain" (== editions.external_id).
// Prefer the authoritative sets map (UUID -> set_id_onchain); fall back to the
// GQL int fields. A row that can't form an integer pair is skipped.
function editionKey(e: RawEdition, setMap: Map<string, string>): string | null {
  const playStr = intLike(e.play?.flowID) ?? intLike(e.play?.id)
  let setStr: string | null = e.set?.id ? (setMap.get(e.set.id) ?? null) : null
  if (!setStr) setStr = intLike(e.set?.flowId) ?? intLike(e.set?.id)
  if (!setStr || !playStr) return null
  return `${setStr}:${playStr}`
}

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

function normalizeEdition(e: RawEdition, externalId: string): BadgeRow {
  const playTags = (e.play?.tags ?? [])
    .filter((t) => t.visible && t.id !== BADGE.INTERACTIVE)
    .map((t) => ({ id: t.id, title: t.title }))
  const setPlayTags = (e.setPlay?.tags ?? [])
    .filter((t) => t.visible && t.id !== BADGE.INTERACTIVE)
    .map((t) => ({ id: t.id, title: t.title }))
  const pIds = new Set(playTags.map((t) => t.id))
  const sIds = new Set(setPlayTags.map((t) => t.id))
  const circ = e.setPlay?.circulations ?? null
  const totalCirc = circ?.circulationCount ?? e.circulationCount ?? 0
  const burned = circ?.burned ?? 0
  const locked = circ?.locked ?? 0
  const owned = circ?.ownedByCollectors ?? 0

  return {
    id: e.id,
    collection_id: COLLECTION_ID,
    collection: COLLECTION_SLUG,
    external_id: externalId,
    set_id: e.set?.id ?? null,
    play_id: e.play?.id ?? null,
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
      pIds.has(BADGE.ROOKIE_YEAR) && pIds.has(BADGE.ROOKIE_PREMIERE) && pIds.has(BADGE.TOP_SHOT_DEBUT),
    has_rookie_mint: sIds.has(BADGE.ROOKIE_MINT),
    badge_score: computeBadgeScore(pIds, sIds),
    circulation_count: totalCirc,
    effective_supply: circ?.effectiveSupply ?? null,
    burned,
    locked,
    owned,
    hidden_in_packs: circ?.hiddenInPacks ?? null,
    burn_rate_pct: totalCirc > 0 ? parseFloat(((burned / totalCirc) * 100).toFixed(1)) : 0,
    lock_rate_pct: owned > 0 ? parseFloat(((locked / owned) * 100).toFixed(1)) : 0,
    flow_retired: e.setPlay?.flowRetired ?? false,
    updated_at: new Date().toISOString(),
  }
}

// int set_id_onchain -> GQL set UUID, from sets.external_id plus sibling
// badge_editions.set_id rows (recovers the ~7 sets sets.external_id misses but
// where some edition already carries the set UUID).
async function fetchSetUuidMap(): Promise<Map<string, string>> {
  const intToUuid = new Map<string, string>() // onchainInt -> setUUID
  const supabase: any = supabaseAdmin

  const { data: setRows } = await supabase
    .from("sets")
    .select("external_id, set_id_onchain")
    .eq("collection_id", COLLECTION_ID)
    .not("set_id_onchain", "is", null)
    .limit(10000)
  for (const r of (setRows ?? []) as Array<{ external_id: string | null; set_id_onchain: number | null }>) {
    if (r.external_id && /^[0-9a-f-]{36}$/.test(r.external_id) && r.set_id_onchain != null) {
      intToUuid.set(String(r.set_id_onchain), r.external_id)
    }
  }

  // Sibling recovery: badge_editions.set_id holds the GQL set UUID for editions
  // already processed; key it by the int prefix of external_id.
  const { data: sibRows } = await supabase
    .from("badge_editions")
    .select("external_id, set_id")
    .eq("collection_id", COLLECTION_ID)
    .not("set_id", "is", null)
    .limit(20000)
  for (const r of (sibRows ?? []) as Array<{ external_id: string | null; set_id: string | null }>) {
    if (!r.external_id || !r.set_id) continue
    const intId = r.external_id.split(":")[0]
    if (/^\d+$/.test(intId) && /^[0-9a-f-]{36}$/.test(r.set_id) && !intToUuid.has(intId)) {
      intToUuid.set(intId, r.set_id)
    }
  }
  return intToUuid
}

async function fetchSetEditions(setUuid: string): Promise<RawEdition[]> {
  type GqlShape = {
    searchEditions: { searchSummary: { data: { data: RawEdition[] } } }
  }
  const data = await topshotGraphql<GqlShape>(QUERY, {
    input: {
      filters: { bySetIDs: [setUuid] },
      searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: PAGE_LIMIT } },
    },
  })
  return data?.searchEditions?.searchSummary?.data?.data ?? []
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  if (!process.env.INGEST_SECRET_TOKEN || bearer !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1"
  const onlySet = req.nextUrl.searchParams.get("set") // restrict to one on-chain set id
  const supabase: any = supabaseAdmin
  const timeBudgetMs = maxDuration * 1000 - TIME_OVERHEAD_MS

  // 1. Missing canonical editions (int-pair external_id, no badge_editions row).
  const missing: Array<{ external_id: string; set_id_onchain: number }> = []
  {
    const { data, error } = await supabase
      .from("editions")
      .select("external_id, set_id_onchain")
      .eq("collection_id", COLLECTION_ID)
      .not("set_id_onchain", "is", null)
      .limit(20000)
    if (error) {
      return NextResponse.json({ error: `editions read failed: ${error.message}` }, { status: 500 })
    }
    // Filter to int-pair external_ids with no badge row. We fetch existing badge
    // external_ids once and diff in memory (cheaper than NOT EXISTS per row).
    const { data: badgeRows } = await supabase
      .from("badge_editions")
      .select("external_id")
      .eq("collection_id", COLLECTION_ID)
      .limit(50000)
    const haveBadge = new Set<string>(
      ((badgeRows ?? []) as Array<{ external_id: string | null }>)
        .map((b) => b.external_id)
        .filter((x): x is string => !!x),
    )
    for (const e of (data ?? []) as Array<{ external_id: string | null; set_id_onchain: number | null }>) {
      if (!e.external_id || e.set_id_onchain == null) continue
      if (!/^[0-9]+:[0-9]+$/.test(e.external_id)) continue
      if (haveBadge.has(e.external_id)) continue
      missing.push({ external_id: e.external_id, set_id_onchain: e.set_id_onchain })
    }
  }

  const setMap = await fetchSetUuidMap()

  // 2. Group missing by on-chain set id; resolve each to a GQL UUID.
  const missingKeys = new Set(missing.map((m) => m.external_id))
  const bySet = new Map<string, Set<string>>() // onchainInt -> missing external_ids
  for (const m of missing) {
    const intId = String(m.set_id_onchain)
    if (onlySet && intId !== onlySet) continue
    if (!bySet.has(intId)) bySet.set(intId, new Set())
    bySet.get(intId)!.add(m.external_id)
  }

  const reachableSets: string[] = []
  const unreachableNoSetUuid: string[] = []
  for (const intId of bySet.keys()) {
    if (setMap.has(intId)) reachableSets.push(intId)
    else unreachableNoSetUuid.push(intId)
  }

  // 3. Per set: fetch all editions, normalize, keep only the missing keys.
  const rowsByKey = new Map<string, BadgeRow>()
  let setsQueried = 0
  let nodesFetched = 0
  let gqlError: string | null = null
  const perSet: Array<{ set: string; editionsReturned: number; matchedMissing: number }> = []

  for (const intId of reachableSets) {
    if (Date.now() - startedAt > timeBudgetMs) { gqlError = gqlError ?? "time_budget_exceeded"; break }
    const setUuid = setMap.get(intId)!
    const wanted = bySet.get(intId)!
    try {
      const editions = await fetchSetEditions(setUuid)
      setsQueried++
      nodesFetched += editions.length
      let matched = 0
      for (const e of editions) {
        const key = editionKey(e, setMap)
        if (!key || !missingKeys.has(key) || !wanted.has(key)) continue
        const existing = rowsByKey.get(key)
        if (existing) mergeTags(existing, e)
        else { rowsByKey.set(key, normalizeEdition(e, key)); matched++ }
      }
      perSet.push({ set: intId, editionsReturned: editions.length, matchedMissing: wanted.size })
      void matched
    } catch (err) {
      gqlError = err instanceof Error ? err.message : String(err)
      // First GQL error almost certainly means a bad field selection — stop so
      // the dryRun surfaces it cleanly rather than hammering every set.
      break
    }
    await sleep(SET_DELAY_MS)
  }

  const rows = Array.from(rowsByKey.values())
  const kdSample = rows.find((r) => r.external_id === "165:6563") ?? null

  // 4. Write (unless dryRun). Purely additive: every row's key was missing, so a
  // plain upsert can't collide with an existing row.
  let upserted = 0
  let upsertErrors = 0
  if (!dryRun && rows.length > 0) {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      const { error } = await supabase
        .from("badge_editions")
        .upsert(batch, { onConflict: "external_id,collection_id" })
      if (error) {
        console.log(`[badge-set-backfill] upsert batch ${i} error:`, error.message)
        upsertErrors++
      } else {
        upserted += batch.length
      }
      if (i + BATCH_SIZE < rows.length) await sleep(BATCH_DELAY_MS)
    }
  }

  const durationMs = Date.now() - startedAt
  const ok = gqlError === null && upsertErrors === 0
  const summary = {
    ok,
    dryRun,
    onlySet: onlySet ?? null,
    totalMissing: missing.length,
    reachableSets: reachableSets.length,
    unreachableNoSetUuidSets: unreachableNoSetUuid.length,
    unreachableNoSetUuidSetIds: unreachableNoSetUuid,
    setsQueried,
    nodesFetched,
    computedRows: rows.length,
    upserted,
    upsertErrors,
    gqlError,
    kdSample: kdSample
      ? {
          external_id: kdSample.external_id,
          player_name: kdSample.player_name,
          set_name: kdSample.set_name,
          play_tags: kdSample.play_tags,
          set_play_tags: kdSample.set_play_tags,
          badge_score: kdSample.badge_score,
        }
      : null,
    sampleRows: rows.slice(0, 8).map((r) => ({
      external_id: r.external_id,
      player_name: r.player_name,
      set_name: r.set_name,
      tier: r.tier,
      play_tags: r.play_tags.map((t) => t.title),
      badge_score: r.badge_score,
    })),
    durationMs,
  }

  if (!dryRun) {
    try {
      await supabase.from("pipeline_runs").insert({
        pipeline: PIPELINE,
        collection_slug: COLLECTION_SLUG,
        started_at: startedAtIso,
        finished_at: new Date().toISOString(),
        rows_found: missing.length,
        rows_written: upserted,
        ok,
        error: gqlError,
        extra: {
          reachable_sets: reachableSets.length,
          unreachable_no_set_uuid_sets: unreachableNoSetUuid.length,
          sets_queried: setsQueried,
          nodes_fetched: nodesFetched,
          computed_rows: rows.length,
          upsert_errors: upsertErrors,
          duration_ms: durationMs,
        },
      })
    } catch {
      // best-effort
    }
  }

  return NextResponse.json(summary)
}
