#!/usr/bin/env node

/**
 * One-off backfill: populate name/player_name/set_name/tier/series for the
 * existing 522-row cohort created by the (now-fixed) hydrate-at-insert call
 * sites before the fix shipped. After this completes, the residual NULL count
 * in the cohort drops to ~40 (TopShot 404s, NFL Draft coverage rows, etc.)
 * which the /edition/[id] fallback h1 covers.
 *
 * Workflow: pull `editions WHERE player_name IS NULL` for NBA TS + AllDay,
 * batch by collection, hydrate via lib/editions-hydrate, UPDATE in place.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-residual-edition-metadata.mjs --dry-run
 *   node --env-file=.env.local scripts/backfill-residual-edition-metadata.mjs
 *
 * --dry-run prints the first 20 (external_id, hydrated_player_name) without
 * writing. Run dry first to verify the parser before letting the live path
 * loose on the full cohort.
 *
 * Delete this file after the run completes — not a long-lived script.
 */

import { readFileSync } from "fs"
import { createClient } from "@supabase/supabase-js"

// Load .env.local if present (mirrors backfill-edition-metadata.mjs convention).
try {
  const envContent = readFileSync(".env.local", "utf-8")
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match) {
      const k = match[1].trim()
      if (!process.env[k]) process.env[k] = match[2].trim()
    }
  }
} catch {
  // .env.local optional — env may already be set
}

const DRY_RUN = process.argv.includes("--dry-run")
const SAMPLE_LIMIT = 20
const BATCH_SIZE = 50
const RATE_LIMIT_RPS = 5
const REQUEST_TIMEOUT_MS = 8_000

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

const TS_PROXY_URL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || null
const ALLDAY_GQL_URL = process.env.AD_PROXY_URL || "https://nflallday.com/consumer/graphql"

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Top Shot hydrator (mirrors lib/editions-hydrate.ts; standalone for ──────
// the script so we don't pull TS path resolution into Node ESM at runtime) ──

const setMetaCache = new Map()

async function tsGql(query, variables) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/backfill",
  }
  if (TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET
  try {
    const res = await fetch(TS_PROXY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = await res.json()
    if (json.errors?.length) return null
    return json.data ?? null
  } catch {
    return null
  }
}

async function fetchTsSetMeta(setID) {
  if (setMetaCache.has(setID)) return setMetaCache.get(setID)
  const data = await tsGql(
    `query GetSet($setID: ID!) { getSet(input: { setID: $setID }) { set { flowName flowSeriesNumber } } }`,
    { setID },
  )
  const set = data?.getSet?.set
  const out = set
    ? {
        setName: set.flowName ? String(set.flowName).trim() : null,
        series: set.flowSeriesNumber != null ? Number(set.flowSeriesNumber) : null,
      }
    : null
  setMetaCache.set(setID, out)
  return out
}

async function fetchTsPlayMeta(playID) {
  const data = await tsGql(
    `query GetPlay($playID: ID!) {
      getPlay(input: { playID: $playID }) {
        play {
          stats {
            playerName
            playCategory
            playType
            dateOfMoment
            teamAtMoment
            homeTeamName
            awayTeamName
          }
          statsPlayerFullName
        }
      }
    }`,
    { playID },
  )
  const play = data?.getPlay?.play
  if (!play) return null
  const s = play.stats ?? {}
  const playerName = play.statsPlayerFullName ?? s.playerName ?? null
  const dateOfMoment = s.dateOfMoment ?? null
  const dateSlice = dateOfMoment ? String(dateOfMoment).slice(0, 10) : null
  const gameDate = dateSlice && /^\d{4}-\d{2}-\d{2}$/.test(dateSlice) ? dateSlice : null
  return {
    playerName: playerName ? String(playerName).trim() : null,
    playCategory: s.playCategory ?? null,
    playType: s.playType ?? null,
    gameDate,
    teamName: s.teamAtMoment ?? null,
    homeTeam: s.homeTeamName ?? null,
    awayTeam: s.awayTeamName ?? null,
  }
}

async function hydrateOneTs(extId) {
  const parts = String(extId).split(":")
  if (parts.length !== 2) return null
  const [setID, playID] = parts
  const [playMeta, setMeta] = await Promise.all([fetchTsPlayMeta(playID), fetchTsSetMeta(setID)])
  if (!playMeta?.playerName) return null
  const setName = setMeta?.setName ?? null
  return {
    name: setName ? `${playMeta.playerName} — ${setName}` : playMeta.playerName,
    player_name: playMeta.playerName,
    set_name: setName,
    team_name: playMeta.teamName,
    series: setMeta?.series ?? null,
    play_type: playMeta.playCategory,
    game_date: playMeta.gameDate,
    home_team: playMeta.homeTeam,
    away_team: playMeta.awayTeam,
  }
}

// ── AllDay hydrator: bulk fetch all editions, build map, look up ────────────

const ALLDAY_RELAY_QUERY = `
  query SeedEditions($first: Int!, $after: String) {
    allEditions(first: $first, after: $after) {
      edges {
        node {
          id
          circulationCount
          tier
          series { name number }
          set { name id }
          play {
            id
            playerName
            team { name }
            classification
            gameDate
            awayTeamName
            homeTeamName
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

function normalizeAllDayTier(raw) {
  if (!raw) return null
  const t = String(raw).toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("COMMON")) return "COMMON"
  return null
}

let alldayMap = null

async function fetchAllDayMap() {
  if (alldayMap) return alldayMap
  const map = new Map()
  let after = null
  for (let page = 0; page < 50; page++) {
    const headers = { "Content-Type": "application/json", "User-Agent": "rip-packs-city/backfill" }
    if (process.env.AD_PROXY_URL && TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET
    const res = await fetch(ALLDAY_GQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: ALLDAY_RELAY_QUERY, variables: { first: 100, after } }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      console.warn(`[allday] HTTP ${res.status} on page ${page} — aborting fetch`)
      break
    }
    const json = await res.json().catch(() => null)
    if (!json || json.errors?.length) {
      console.warn(`[allday] GQL errors on page ${page}: ${JSON.stringify(json?.errors ?? "no body")}`)
      break
    }
    const conn = json.data?.allEditions
    const edges = conn?.edges ?? []
    for (const edge of edges) {
      const n = edge?.node
      if (!n) continue
      const setId = n.set?.id ?? null
      const playId = n.play?.id ?? null
      const composite = setId && playId ? `${setId}:${playId}` : null
      const gqlId = n.id ?? null
      const meta = {
        player_name: n.play?.playerName ?? null,
        set_name: n.set?.name ?? null,
        team_name: n.play?.team?.name ?? null,
        tier: normalizeAllDayTier(n.tier),
        series: n.series?.number ?? null,
        circulation_count: n.circulationCount ?? null,
        play_type: n.play?.classification ?? null,
        game_date: n.play?.gameDate ?? null,
        home_team: n.play?.homeTeamName ?? null,
        away_team: n.play?.awayTeamName ?? null,
      }
      if (composite) map.set(composite, meta)
      if (gqlId) map.set(String(gqlId), meta)
    }
    console.log(`[allday] page ${page + 1}: ${edges.length} editions (cumulative map size ${map.size})`)
    if (!conn?.pageInfo?.hasNextPage) break
    after = conn.pageInfo.endCursor ?? null
    if (!after) break
  }
  alldayMap = map
  return map
}

async function hydrateOneAllDay(extId) {
  const map = await fetchAllDayMap()
  const meta = map.get(String(extId))
  if (!meta?.player_name) return null
  const name = meta.set_name ? `${meta.player_name} — ${meta.set_name}` : meta.player_name
  return {
    name,
    player_name: meta.player_name,
    set_name: meta.set_name,
    team_name: meta.team_name,
    tier: meta.tier,
    series: meta.series,
    circulation_count: meta.circulation_count,
    play_type: meta.play_type,
    game_date: meta.game_date,
    home_team: meta.home_team,
    away_team: meta.away_team,
  }
}

// ── Driver ───────────────────────────────────────────────────────────────────

async function loadCohort(collectionId) {
  const out = []
  let from = 0
  const pageSize = 1000
  for (;;) {
    const { data, error } = await supabase
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", collectionId)
      .is("player_name", null)
      .order("external_id", { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`cohort load: ${error.message}`)
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  return out
}

async function processCollection(label, collectionId, hydrateOne) {
  console.log(`\n━━━ ${label} ━━━`)
  const cohort = await loadCohort(collectionId)
  console.log(`  cohort size: ${cohort.length}`)
  if (cohort.length === 0) return { updated: 0, failed: 0 }

  let updated = 0
  let failed = 0
  let printed = 0
  const samples = []

  // 5 RPS = 200ms between calls; we hydrate in batches of BATCH_SIZE with
  // sequential dispatch so the cap holds across the whole script run.
  const tickMs = Math.ceil(1000 / RATE_LIMIT_RPS)

  for (let i = 0; i < cohort.length; i += BATCH_SIZE) {
    const batch = cohort.slice(i, i + BATCH_SIZE)
    for (const row of batch) {
      const extId = row.external_id
      const meta = await hydrateOne(extId)
      if (!meta) {
        failed++
        if (DRY_RUN && printed < SAMPLE_LIMIT) {
          samples.push({ external_id: extId, hydrated_player_name: null })
          printed++
        }
        await delay(tickMs)
        continue
      }

      if (DRY_RUN) {
        if (printed < SAMPLE_LIMIT) {
          samples.push({ external_id: extId, hydrated_player_name: meta.player_name })
          printed++
        }
        updated++
      } else {
        const { error } = await supabase
          .from("editions")
          .update(meta)
          .eq("id", row.id)
          .is("player_name", null)
        if (error) {
          console.warn(`  ✗ ${extId}: ${error.message}`)
          failed++
        } else {
          updated++
        }
      }
      await delay(tickMs)
    }
    if (!DRY_RUN) {
      console.log(`  progress ${Math.min(i + BATCH_SIZE, cohort.length)}/${cohort.length}: updated=${updated} failed=${failed}`)
    }
    if (DRY_RUN && printed >= SAMPLE_LIMIT) break
  }

  if (DRY_RUN) {
    console.log(`  DRY RUN — first ${samples.length} samples:`)
    for (const s of samples) {
      console.log(`    ${s.external_id} → ${s.hydrated_player_name ?? "<no resolve>"}`)
    }
    console.log(`  (full cohort would be ${cohort.length} rows; processing skipped)`)
  } else {
    console.log(`  ${label}: updated=${updated} failed=${failed}`)
  }

  return { updated, failed }
}

async function main() {
  const start = Date.now()
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"}`)
  console.log(`TS proxy: ${TS_PROXY_URL}`)
  console.log(`AllDay GQL: ${ALLDAY_GQL_URL}`)

  const ts = await processCollection("NBA Top Shot", TS_COLLECTION_ID, hydrateOneTs)
  const ad = await processCollection("NFL All Day", ALLDAY_COLLECTION_ID, hydrateOneAllDay)

  console.log(`\n═══ SUMMARY (${DRY_RUN ? "DRY" : "LIVE"}) ═══`)
  console.log(`  Top Shot:  updated=${ts.updated}  failed=${ts.failed}`)
  console.log(`  All Day:   updated=${ad.updated}  failed=${ad.failed}`)
  console.log(`  Elapsed:   ${((Date.now() - start) / 1000).toFixed(1)}s`)
  if (DRY_RUN) {
    console.log("\nRe-run without --dry-run to apply.")
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
