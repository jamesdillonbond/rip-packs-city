#!/usr/bin/env node

/**
 * Backfill team_name and stub edition names from Top Shot GQL.
 *
 * Usage: node scripts/backfill-edition-metadata.mjs
 */

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const PROXY_URL = "https://topshot-proxy.tdillonbond.workers.dev/graphql"
const DIRECT_URL = "https://public-api.nbatopshot.com/graphql"
const GQL_URL = process.env.TS_PROXY_SECRET ? PROXY_URL : DIRECT_URL
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
}
if (process.env.TS_PROXY_SECRET) {
  GQL_HEADERS["X-Proxy-Secret"] = process.env.TS_PROXY_SECRET
}
console.log(`[backfill-edition-metadata] GQL endpoint: ${GQL_URL === PROXY_URL ? "Cloudflare proxy" : "direct"}`)

const DELAY_MS = 200
const BATCH_SIZE = 50

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

const GQL_QUERY = `
  query GetMintedMoment($momentId: ID!) {
    getMintedMoment(input: { momentId: $momentId }) {
      data {
        ... on MintedMoment {
          play {
            ... on Play {
              id
              headline
              stats
              statsPlayerGameScores {
                teamAtMoment
                playerName
              }
            }
          }
          set {
            ... on Set {
              id
              flowName
              flowSeriesNumber
            }
          }
        }
      }
    }
  }
`

async function fetchMomentMeta(momentId) {
  try {
    const res = await fetch(GQL_URL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({ query: GQL_QUERY, variables: { momentId } }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const json = await res.json()
    const data = json?.data?.getMintedMoment?.data
    if (!data) return null

    const scores = data.play?.statsPlayerGameScores
    const teamAtMoment = Array.isArray(scores) && scores.length > 0 ? scores[0].teamAtMoment : null
    const playerName = Array.isArray(scores) && scores.length > 0
      ? scores[0].playerName
      : data.play?.headline ?? null
    const setName = data.set?.flowName ?? null

    return { teamAtMoment, playerName, setName }
  } catch (err) {
    console.log(`  GQL error for moment ${momentId}: ${err.message}`)
    return null
  }
}

async function main() {
  const start = Date.now()
  console.log("Fetching editions needing team_name or name backfill...")

  // Fetch editions where team_name IS NULL OR name IS NULL
  const { data: editions, error } = await supabase
    .from("editions")
    .select("id, external_id, name, player_name, team_name")
    .eq("collection_id", TOPSHOT_COLLECTION_ID)
    .or("team_name.is.null,name.is.null")
    .limit(2000)

  if (error) {
    console.error("Failed to fetch editions:", error.message)
    process.exit(1)
  }

  console.log(`Found ${editions.length} editions needing backfill`)

  let updated = 0
  let skipped = 0
  let gqlFails = 0

  for (let i = 0; i < editions.length; i++) {
    const ed = editions[i]

    // Find a moment in wallet_moments_cache for this edition
    const { data: momentRows } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id")
      .eq("edition_key", ed.external_id)
      .limit(1)

    if (!momentRows || momentRows.length === 0) {
      skipped++
      continue
    }

    const momentId = momentRows[0].moment_id
    const meta = await fetchMomentMeta(momentId)

    if (!meta) {
      gqlFails++
      await delay(DELAY_MS)
      continue
    }

    const patch = {}
    if (!ed.team_name && meta.teamAtMoment) {
      patch.team_name = meta.teamAtMoment.trim()
    }
    if (!ed.name && meta.playerName && meta.setName) {
      patch.name = `${meta.playerName.trim()} — ${meta.setName.trim()}`
    }
    if (!ed.player_name && meta.playerName) {
      patch.player_name = meta.playerName.trim()
    }

    if (Object.keys(patch).length > 0) {
      const { error: updateErr } = await supabase
        .from("editions")
        .update(patch)
        .eq("id", ed.id)

      if (updateErr) {
        console.log(`  ✗ Edition ${ed.external_id}: ${updateErr.message}`)
      } else {
        updated++
      }
    }

    if ((i + 1) % BATCH_SIZE === 0) {
      console.log(`  Progress: ${i + 1}/${editions.length} | updated: ${updated} | skipped: ${skipped} | gql fails: ${gqlFails}`)
    }

    await delay(DELAY_MS)
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`
════════════════════════════════════════
  PHASE 1 COMPLETE — moment-backed editions
  Total editions:  ${editions.length}
  Updated:         ${updated}
  Skipped (no moment): ${skipped}
  GQL failures:    ${gqlFails}
  Elapsed:         ${elapsed}s
════════════════════════════════════════`)

  // ── Phase 2: UUID-format editions with no matching moment ────────────────
  // These are skipped by phase 1 because there's no wallet_moments_cache row
  // to supply a flowId. Instead we query Top Shot GQL directly with the set
  // and play UUIDs parsed out of external_id.
  await phase2UuidBackfill()
}

// ── Phase 2 helpers ──────────────────────────────────────────────────────────

const GET_PLAY_QUERY = `
  query GetPlay($playID: ID!) {
    getPlay(input: { playID: $playID }) {
      play {
        stats { playerName teamAtMomentNbaId playCategory dateOfMoment }
        statsPlayerFullName
      }
    }
  }
`

const GET_SET_QUERY = `
  query GetSet($setID: ID!) {
    getSet(input: { setID: $setID }) {
      set { flowName flowSeriesNumber }
    }
  }
`

async function gqlFetch(query, variables) {
  try {
    const res = await fetch(GQL_URL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const json = await res.json()
    return json?.data ?? null
  } catch {
    return null
  }
}

async function fetchPlayMeta(playId) {
  const d = await gqlFetch(GET_PLAY_QUERY, { playID: playId })
  const play = d?.getPlay?.play
  if (!play) return null
  const stats = play.stats ?? {}
  const playerName = play.statsPlayerFullName ?? stats.playerName ?? null
  return {
    playerName: playerName ? String(playerName).trim() : null,
    playCategory: stats.playCategory ?? null,
    dateOfMoment: stats.dateOfMoment ?? null,
    teamAtMomentNbaId: stats.teamAtMomentNbaId ?? null,
  }
}

// Memoize set lookups so we don't re-query the same set UUID 100 times.
const setCache = new Map()
async function fetchSetMeta(setId) {
  if (setCache.has(setId)) return setCache.get(setId)
  const d = await gqlFetch(GET_SET_QUERY, { setID: setId })
  const set = d?.getSet?.set
  const meta = set
    ? {
        setName: set.flowName ? String(set.flowName).trim() : null,
        seriesNumber: set.flowSeriesNumber ?? null,
      }
    : null
  setCache.set(setId, meta)
  return meta
}

async function processUuidEdition(ed) {
  const [setUuid, playUuid] = String(ed.external_id).split(":")
  if (!setUuid || !playUuid) return "failed"

  const [playMeta, setMeta] = await Promise.all([
    fetchPlayMeta(playUuid),
    fetchSetMeta(setUuid),
  ])

  if (!playMeta?.playerName && !setMeta?.setName) return "failed"

  const patch = {}
  if (!ed.player_name && playMeta?.playerName) patch.player_name = playMeta.playerName
  if (!ed.set_name && setMeta?.setName) patch.set_name = setMeta.setName
  if (!ed.name && playMeta?.playerName && setMeta?.setName) {
    patch.name = `${playMeta.playerName} — ${setMeta.setName}`
  }
  if (setMeta?.seriesNumber != null) patch.series = setMeta.seriesNumber

  if (Object.keys(patch).length === 0) return "failed"

  const { error } = await supabase.from("editions").update(patch).eq("id", ed.id)
  if (error) {
    console.log(`  ✗ Edition ${ed.external_id}: ${error.message}`)
    return "failed"
  }
  return "updated"
}

async function phase2UuidBackfill() {
  const start = Date.now()
  console.log("\nPhase 2: UUID editions with no matching moment…")

  // UUID external_ids contain dashes. Filter to ones still missing player_name.
  const { data: editions, error } = await supabase
    .from("editions")
    .select("id, external_id, name, player_name, set_name")
    .eq("collection_id", TOPSHOT_COLLECTION_ID)
    .is("player_name", null)
    .like("external_id", "%-%")
    .limit(2000)

  if (error) {
    console.error("Phase 2 fetch failed:", error.message)
    return
  }

  const targets = (editions ?? []).filter((e) => {
    const [a, b] = String(e.external_id).split(":")
    return a && b && a.includes("-") && b.includes("-")
  })

  console.log(`Found ${targets.length} UUID editions to resolve`)

  let updated = 0
  let failed = 0
  const CONCURRENCY = 8
  const BATCH_DELAY_MS = 200
  const LOG_EVERY = 50

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY)
    const outcomes = await Promise.all(batch.map(processUuidEdition))
    for (const r of outcomes) {
      if (r === "updated") updated++
      else failed++
    }
    const processed = Math.min(i + CONCURRENCY, targets.length)
    if (processed % LOG_EVERY < CONCURRENCY || processed === targets.length) {
      console.log(`  Progress: ${processed}/${targets.length} | updated: ${updated} | failed: ${failed}`)
    }
    if (i + CONCURRENCY < targets.length) await delay(BATCH_DELAY_MS)
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`
════════════════════════════════════════
  PHASE 2 COMPLETE — UUID editions
  Total candidates: ${targets.length}
  Updated:          ${updated}
  Failed:           ${failed}
  Elapsed:          ${elapsed}s
════════════════════════════════════════`)
}

main().catch(err => {
  console.error("Fatal:", err)
  process.exit(1)
})
