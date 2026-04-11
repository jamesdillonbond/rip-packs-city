#!/usr/bin/env node

/**
 * Backfill team_name / player_name / set_name / edition name from Top Shot GQL.
 *
 * Usage: node --env-file=.env.local scripts/backfill-edition-metadata.mjs
 *
 * Two phases:
 *   1. Editions with matching moments in wallet_moments_cache → look up via flowId
 *   2. UUID-format editions (no matching moments) → look up via play/set UUIDs
 *
 * Both phases route through the Cloudflare Worker proxy (TS_PROXY_URL +
 * TS_PROXY_SECRET) when those env vars are set. Without the proxy, Cloudflare
 * blocks local IPs from hitting the Top Shot GQL directly.
 */

import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const DELAY_MS = 200
const BATCH_SIZE = 50

const TS_PROXY_URL = process.env.TS_PROXY_URL
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET

async function topshotGql(query, variables) {
  const url = TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
  const headers = { "Content-Type": "application/json" }
  if (TS_PROXY_URL && TS_PROXY_SECRET) {
    headers["X-Proxy-Secret"] = TS_PROXY_SECRET
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error("GQL " + res.status + ": " + text.slice(0, 200))
  }
  const json = await res.json()
  if (json.errors && json.errors.length) throw new Error(json.errors[0].message)
  return json.data
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Phase 1 query (moment-backed editions) ──────────────────────────────────

const GET_MINTED_MOMENT_QUERY = `
  query GetMintedMoment($momentId: ID!) {
    getMintedMoment(momentId: $momentId) {
      data {
        ... on MintedMoment {
          play {
            ... on Play {
              id
              headline

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
    const data = await topshotGql(GET_MINTED_MOMENT_QUERY, { momentId })
    const m = data?.getMintedMoment?.data
    if (!m) return null

    const playerName = m.play?.headline ?? null
    const teamAtMoment = null
    const setName = m.set?.flowName ?? null

    return { teamAtMoment, playerName, setName }
  } catch (err) {
    console.log(`  GQL error for moment ${momentId}: ${err.message}`)
    return null
  }
}

async function main() {
  const start = Date.now()
  console.log("Proxy:", TS_PROXY_URL ? TS_PROXY_URL : "DIRECT (no proxy — may be blocked by Cloudflare)")
  console.log("Fetching editions needing team_name or name backfill...")

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
  await phase2UuidBackfill()
}

// ── Phase 2 queries ──────────────────────────────────────────────────────────

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

async function fetchPlayMeta(playId) {
  try {
    const data = await topshotGql(GET_PLAY_QUERY, { playID: playId })
    const play = data?.getPlay?.play
    if (!play) return null
    const stats = play.stats ?? {}
    const playerName = play.statsPlayerFullName ?? stats.playerName ?? null
    return {
      playerName: playerName ? String(playerName).trim() : null,
      playCategory: stats.playCategory ?? null,
      dateOfMoment: stats.dateOfMoment ?? null,
      teamAtMomentNbaId: stats.teamAtMomentNbaId ?? null,
    }
  } catch {
    return null
  }
}

// Memoize set lookups so we don't re-query the same set UUID 100 times.
const setCache = new Map()
async function fetchSetMeta(setId) {
  if (setCache.has(setId)) return setCache.get(setId)
  let meta = null
  try {
    const data = await topshotGql(GET_SET_QUERY, { setID: setId })
    const set = data?.getSet?.set
    meta = set
      ? {
          setName: set.flowName ? String(set.flowName).trim() : null,
          seriesNumber: set.flowSeriesNumber ?? null,
        }
      : null
  } catch {
    meta = null
  }
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


