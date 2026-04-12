#!/usr/bin/env node

/**
 * seed-allday-editions.mjs — Bulk-seed NFL All Day editions from GQL into Supabase.
 *
 * Uses the nflallday.com consumer/graphql endpoint (or proxy if AD_PROXY_URL is set).
 * Fetches all editions via pagination, then upserts into the `editions` table
 * with collection_id = dee28451-5d62-409e-a1ad-a83f763ac070.
 *
 * Usage:
 *   node scripts/seed-allday-editions.mjs
 *
 * Env vars:
 *   NEXT_PUBLIC_SUPABASE_URL    — Supabase URL
 *   SUPABASE_SERVICE_ROLE_KEY   — Supabase service role key
 *   AD_PROXY_URL                — (optional) Cloudflare proxy URL for All Day GQL
 *   TS_PROXY_SECRET             — (optional) proxy auth secret
 */

import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

// GQL endpoint — prefer proxy if available (Cloudflare blocks Vercel IPs)
const GQL_URL = process.env.AD_PROXY_URL
  ? process.env.AD_PROXY_URL
  : "https://nflallday.com/consumer/graphql"

function gqlHeaders() {
  const h = { "Content-Type": "application/json", "User-Agent": "sports-collectible-tool/0.1" }
  if (process.env.AD_PROXY_URL && process.env.TS_PROXY_SECRET) {
    h["X-Proxy-Secret"] = process.env.TS_PROXY_SECRET
  }
  return h
}

// ── GQL Queries ──────────────────────────────────────────────────────────────

// Try multiple query shapes — All Day GQL schema varies between endpoints
const EDITIONS_QUERY_RELAY = `
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
            description
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

// Alternate flat query if relay-style doesn't work
const EDITIONS_QUERY_FLAT = `
  query SeedEditions($limit: Int!, $offset: Int) {
    searchEditions(input: { pagination: { first: $limit, after: $offset } }) {
      edges {
        node {
          id
          flowId
          circulationCount
          tier
          seriesName
          setName
          playId
          playerName
          teamName
          playType
          gameDate
        }
      }
      totalCount
      pageInfo { hasNextPage endCursor }
    }
  }
`

async function gqlFetch(query, variables) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: gqlHeaders(),
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`GQL HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`GQL parse error: ${text.slice(0, 300)}`) }
  if (json.errors?.length) {
    throw new Error(`GQL errors: ${json.errors.map(e => e.message).join("; ")}`)
  }
  return json.data
}

// ── Fetch all editions via relay pagination ──────────────────────────────────

async function fetchAllEditionsRelay() {
  console.log("[seed] Trying relay-style allEditions query...")
  const editions = []
  let after = null
  let page = 0

  while (true) {
    page++
    const vars = { first: 100, after }
    const data = await gqlFetch(EDITIONS_QUERY_RELAY, vars)
    const connection = data.allEditions
    if (!connection?.edges) throw new Error("No allEditions.edges in response")

    for (const edge of connection.edges) {
      const n = edge.node
      editions.push({
        gqlId: n.id,
        circulationCount: n.circulationCount ?? null,
        tier: normalizeTier(n.tier),
        seriesNumber: n.series?.number ?? null,
        seriesName: n.series?.name ?? null,
        setName: n.set?.name ?? null,
        setId: n.set?.id ?? null,
        playId: n.play?.id ?? null,
        playerName: n.play?.playerName ?? null,
        teamName: n.play?.team?.name ?? null,
        playType: n.play?.classification ?? null,
        gameDate: n.play?.gameDate ?? null,
        homeTeam: n.play?.homeTeamName ?? null,
        awayTeam: n.play?.awayTeamName ?? null,
      })
    }

    console.log(`  page ${page}: ${connection.edges.length} editions (total: ${editions.length})`)

    if (!connection.pageInfo?.hasNextPage) break
    after = connection.pageInfo.endCursor
  }

  return editions
}

async function fetchAllEditionsFlat() {
  console.log("[seed] Trying flat searchEditions query...")
  const editions = []
  let offset = 0
  const limit = 100
  let page = 0

  while (true) {
    page++
    const vars = { limit, offset }
    const data = await gqlFetch(EDITIONS_QUERY_FLAT, vars)
    const connection = data.searchEditions
    if (!connection?.edges) throw new Error("No searchEditions.edges in response")

    for (const edge of connection.edges) {
      const n = edge.node
      editions.push({
        gqlId: n.id ?? n.flowId,
        circulationCount: n.circulationCount ?? null,
        tier: normalizeTier(n.tier),
        seriesNumber: null, // extract from seriesName
        seriesName: n.seriesName ?? null,
        setName: n.setName ?? null,
        setId: null,
        playId: n.playId ?? null,
        playerName: n.playerName ?? null,
        teamName: n.teamName ?? null,
        playType: n.playType ?? null,
        gameDate: n.gameDate ?? null,
        homeTeam: null,
        awayTeam: null,
      })
    }

    console.log(`  page ${page}: ${connection.edges.length} editions (total: ${editions.length})`)

    if (!connection.pageInfo?.hasNextPage || connection.edges.length < limit) break
    offset += limit
  }

  return editions
}

function normalizeTier(raw) {
  if (!raw) return "COMMON"
  const t = String(raw).toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  return "COMMON"
}

// Series name → number mapping (from collection_series table)
const SERIES_NAME_TO_NUM = {
  "series 1": 0,
  "series 2": 1,
  "series 3": 2,
  "series 4": 3,
  "series 5": 4,
}

function resolveSeriesNumber(edition) {
  if (edition.seriesNumber != null) return edition.seriesNumber
  if (edition.seriesName) {
    const key = edition.seriesName.toLowerCase().trim()
    if (SERIES_NAME_TO_NUM[key] !== undefined) return SERIES_NAME_TO_NUM[key]
    // Try extracting number
    const match = key.match(/(\d+)/)
    if (match) return parseInt(match[1], 10) - 1 // "Series 1" → 0
  }
  return null
}

// ── Build edition key ────────────────────────────────────────────────────────
// All Day uses setID:playID as the edition key (same format as Top Shot).
// If GQL gives us set.id and play.id, we compose them.
// If not, we use the GQL id as-is as the external_id.

function buildEditionKey(edition) {
  // If we have both set and play IDs, use them
  if (edition.setId && edition.playId) {
    return `${edition.setId}:${edition.playId}`
  }
  // Otherwise use the GQL ID as external_id
  return edition.gqlId ?? null
}

// ── Supabase upsert ──────────────────────────────────────────────────────────

async function upsertEditions(editions) {
  const now = new Date().toISOString()
  const rows = editions
    .map(ed => {
      const externalId = buildEditionKey(ed)
      if (!externalId) return null
      return {
        external_id: externalId,
        collection_id: ALLDAY_COLLECTION_ID,
        collection: "nfl_all_day",
        player_name: ed.playerName ?? null,
        set_name: ed.setName ?? null,
        team_name: ed.teamName ?? null,
        tier: ed.tier,
        series: resolveSeriesNumber(ed),
        circulation_count: ed.circulationCount ?? null,
        play_type: ed.playType ?? null,
        game_date: ed.gameDate ?? null,
        home_team: ed.homeTeam ?? null,
        away_team: ed.awayTeam ?? null,
        thumbnail_url: null, // Will be generated from media pattern in collection_config
        updated_at: now,
      }
    })
    .filter(Boolean)

  console.log(`\n[seed] Upserting ${rows.length} editions into Supabase...`)

  let inserted = 0
  let errors = 0
  const CHUNK = 100

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await supabase
      .from("editions")
      .upsert(chunk, { onConflict: "external_id,collection_id" })

    if (error) {
      console.error(`  chunk ${i}-${i + chunk.length} error: ${error.message}`)
      errors += chunk.length
      // Try one-by-one to find bad rows
      for (const row of chunk) {
        const { error: singleErr } = await supabase
          .from("editions")
          .upsert([row], { onConflict: "external_id,collection_id" })
        if (singleErr) {
          console.error(`  bad row ${row.external_id}: ${singleErr.message}`)
        } else {
          inserted++
          errors--
        }
      }
    } else {
      inserted += chunk.length
    }
  }

  console.log(`[seed] Done: ${inserted} upserted, ${errors} errors`)
  return { inserted, errors }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════")
  console.log("  NFL ALL DAY EDITION SEED")
  console.log("  GQL endpoint:", GQL_URL)
  console.log("  Collection ID:", ALLDAY_COLLECTION_ID)
  console.log("═══════════════════════════════════════════")

  let editions

  // Try relay-style first, fall back to flat search
  try {
    editions = await fetchAllEditionsRelay()
  } catch (relayErr) {
    console.log(`[seed] Relay query failed: ${relayErr.message}`)
    console.log("[seed] Falling back to searchEditions...")
    try {
      editions = await fetchAllEditionsFlat()
    } catch (flatErr) {
      console.error(`[seed] Both queries failed. Flat error: ${flatErr.message}`)
      process.exit(1)
    }
  }

  if (editions.length === 0) {
    console.log("[seed] No editions found — check GQL endpoint and query")
    process.exit(0)
  }

  console.log(`\n[seed] Fetched ${editions.length} editions from GQL`)
  console.log(`  Tiers: ${JSON.stringify(countBy(editions, "tier"))}`)
  console.log(`  Series: ${JSON.stringify(countBy(editions, "seriesName"))}`)

  const { inserted, errors } = await upsertEditions(editions)

  console.log("\n═══ SEED COMPLETE ═══")
  console.log(`  Total fetched:  ${editions.length}`)
  console.log(`  Inserted:       ${inserted}`)
  console.log(`  Errors:         ${errors}`)

  // Verify
  const { count } = await supabase
    .from("editions")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", ALLDAY_COLLECTION_ID)
  console.log(`  Editions in DB: ${count}`)
}

function countBy(arr, key) {
  const map = {}
  for (const item of arr) {
    const val = item[key] ?? "null"
    map[val] = (map[val] || 0) + 1
  }
  return map
}

main().catch(err => {
  console.error("Fatal:", err)
  process.exit(1)
})
