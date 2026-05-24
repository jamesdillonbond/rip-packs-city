#!/usr/bin/env node

/**
 * Phase 2B (widened). Rehydrate any TopShot editions row where set_name,
 * player_name, circulation_count, or tier is NULL by re-running the canonical
 * SearchEditionBackfill GQL through the topshot-proxy worker.
 *
 * The original filter only caught fully-NULL or NULL-player rows. Widening to
 * include circulation_count and tier picks up partial-hydrate stragglers (the
 * GQL ran once and populated set_name/player_name but the response was missing
 * other fields). Some genuinely 404 against the public-api schema (retired
 * plays, draft / unreleased editions, UUID:UUID multi-player challenges) —
 * those return null from hydrateOne and are left alone. The strip-nulls patch
 * step further protects rows from regressions when GQL only returns a partial
 * record on the second attempt.
 *
 * Usage:
 *   node --env-file=.env.local scripts/rehydrate-null-topshot-editions.mjs --dry-run
 *   node --env-file=.env.local scripts/rehydrate-null-topshot-editions.mjs
 *
 * --dry-run prints the first 20 (external_id, hydrated_player_name) without
 * writing.
 *
 * Companion to scripts/backfill-residual-edition-metadata.mjs — which kept
 * the AllDay path in scope. This one is TopShot-only and uses the broader
 * (set_name IS NULL OR player_name IS NULL) filter so partial-hydrate rows
 * get a second chance the older script's player_name-only filter missed.
 */

import { readFileSync } from "fs"
import { createClient } from "@supabase/supabase-js"

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
const TS_PROXY_URL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || null

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

const SEARCH_EDITION_QUERY = `
  query SearchEditionBackfill($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
        data {
          ... on Editions {
            data {
              ... on Edition {
                tier
                circulationCount
                set {
                  flowId
                  flowName
                  flowSeriesNumber
                }
                play {
                  flowID
                  stats {
                    playerName
                    teamAtMoment
                    teamAtMomentNbaId
                    playCategory
                    playType
                    dateOfMoment
                    homeTeamName
                    awayTeamName
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`

async function tsGql(query, variables, operationName) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/rehydrate",
  }
  if (TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET
  const body = { query, variables }
  if (operationName) body.operationName = operationName
  try {
    const res = await fetch(TS_PROXY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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

function normalizeTier(raw) {
  if (!raw) return null
  const t = String(raw).toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("FANDOM")) return "FANDOM"
  if (t.includes("COMMON")) return "COMMON"
  return null
}

async function hydrateOne(extId) {
  const parts = String(extId).split(":")
  if (parts.length !== 2) return null
  const [setID, playID] = parts
  if (!setID || !playID) return null

  const data = await tsGql(
    SEARCH_EDITION_QUERY,
    {
      input: {
        filters: { bySetIDs: [setID], byPlayIDs: [playID] },
        searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 1 } },
      },
    },
    "SearchEditionBackfill",
  )
  const row = data?.searchEditions?.searchSummary?.data?.data?.[0]
  if (!row) return null
  const s = row.play?.stats ?? {}
  const playerName = s.playerName ? String(s.playerName).trim() : null
  const setName = row.set?.flowName ? String(row.set.flowName).trim() : null
  if (!playerName && !setName) return null

  const dateOfMoment = s.dateOfMoment ?? null
  const dateSlice = dateOfMoment ? String(dateOfMoment).slice(0, 10) : null
  const gameDate = dateSlice && /^\d{4}-\d{2}-\d{2}$/.test(dateSlice) ? dateSlice : null

  // Bug fix (2026-05-24): the GQL response carries the on-chain integer IDs
  // in row.set.flowId / row.play.flowID regardless of external_id format, so
  // UUID:UUID rows can be fully hydrated with set_id_onchain / play_id_onchain
  // without a second lookup. The old code only filled these when external_id
  // matched ^\d+:\d+$ and silently left UUID:UUID rows with NULL integer
  // columns — the very state that caused 992 stubs to leak past
  // topshot-stub-resolver in the first place.
  const intPair = /^\d+:\d+$/.test(extId)
  const setFromExt = intPair && /^\d+$/.test(setID) ? Number(setID) : null
  const playFromExt = intPair && /^\d+$/.test(playID) ? Number(playID) : null
  const setFromGql = row.set?.flowId != null && Number.isFinite(Number(row.set.flowId))
    ? Number(row.set.flowId)
    : null
  const playFromGql = row.play?.flowID != null && Number.isFinite(Number(row.play.flowID))
    ? Number(row.play.flowID)
    : null
  const setIdOnchain = setFromGql ?? setFromExt
  const playIdOnchain = playFromGql ?? playFromExt

  const name = playerName && setName ? `${playerName} — ${setName}` : (playerName ?? setName)

  return {
    name,
    player_name: playerName,
    set_name: setName,
    team_name: s.teamAtMoment ?? null,
    tier: normalizeTier(row.tier),
    series: row.set?.flowSeriesNumber != null ? Number(row.set.flowSeriesNumber) : null,
    circulation_count: row.circulationCount ?? null,
    set_id_onchain: setIdOnchain,
    play_id_onchain: playIdOnchain,
    play_type: s.playType ?? s.playCategory ?? null,
    game_date: gameDate,
    home_team: s.homeTeamName ?? null,
    away_team: s.awayTeamName ?? null,
  }
}

async function loadCohort() {
  // Pulls every TopShot edition still missing at least one of: set_name,
  // player_name, circulation_count, tier, set_id_onchain, play_id_onchain.
  // The trailing two were added 2026-05-24 to catch UUID:UUID rows where
  // the old script had populated metadata but skipped the integer columns
  // (the leak that left topshot-stub-resolver staring at a 992-row cohort
  // it could never match).
  const { data, error } = await supabase
    .from("editions")
    .select("id, external_id")
    .eq("collection_id", TS_COLLECTION_ID)
    .or("set_name.is.null,player_name.is.null,circulation_count.is.null,tier.is.null,set_id_onchain.is.null,play_id_onchain.is.null")
    .order("created_at", { ascending: false })
    .limit(2000)
  if (error) throw new Error(`cohort load: ${error.message}`)
  return data ?? []
}

async function main() {
  const start = Date.now()
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"}`)
  console.log(`TS proxy: ${TS_PROXY_URL}`)

  const cohort = await loadCohort()
  console.log(`Cohort size: ${cohort.length} (TopShot rows with NULL set_name OR player_name)`)
  if (cohort.length === 0) return

  const tickMs = Math.ceil(1000 / RATE_LIMIT_RPS)
  let updated = 0
  let unresolved = 0
  let skippedShape = 0
  const samples = []

  for (let i = 0; i < cohort.length; i++) {
    const row = cohort[i]
    const extId = row.external_id
    const meta = await hydrateOne(extId)
    if (!meta) {
      unresolved++
      if (samples.length < SAMPLE_LIMIT) samples.push({ external_id: extId, hydrated_player_name: null })
      await delay(tickMs)
      continue
    }

    if (DRY_RUN) {
      if (samples.length < SAMPLE_LIMIT) samples.push({ external_id: extId, hydrated_player_name: meta.player_name })
      updated++
    } else {
      // Strip null values so we don't overwrite already-populated columns with
      // null when the GQL response is partial (e.g. set_name populated but
      // player_name still missing on a partial-hydrate row).
      const patch = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== null && v !== undefined))
      if (Object.keys(patch).length === 0) {
        skippedShape++
        await delay(tickMs)
        continue
      }
      const { error } = await supabase
        .from("editions")
        .update(patch)
        .eq("id", row.id)
      if (error) {
        console.warn(`  ✗ ${extId}: ${error.message}`)
        unresolved++
      } else {
        updated++
      }
    }
    await delay(tickMs)
  }

  console.log(`\n═══ SUMMARY (${DRY_RUN ? "DRY" : "LIVE"}) ═══`)
  console.log(`  updated:     ${updated}`)
  console.log(`  unresolved:  ${unresolved}`)
  if (skippedShape > 0) console.log(`  empty patch: ${skippedShape}`)
  console.log(`  elapsed:     ${((Date.now() - start) / 1000).toFixed(1)}s`)
  if (DRY_RUN) {
    console.log(`\nFirst ${samples.length} samples:`)
    for (const s of samples) {
      console.log(`  ${s.external_id} → ${s.hydrated_player_name ?? "<no resolve>"}`)
    }
    console.log("\nRe-run without --dry-run to apply.")
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
