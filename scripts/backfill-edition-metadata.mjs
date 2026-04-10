#!/usr/bin/env node

/**
 * Backfill team_name and stub edition names from Top Shot GQL.
 *
 * Usage: node scripts/backfill-edition-metadata.mjs
 */

import "dotenv/config"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const GQL_URL = process.env.TS_PROXY_URL
  ? `https://${process.env.TS_PROXY_URL}`
  : "https://public-api.nbatopshot.com/graphql"
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
}
if (process.env.TS_PROXY_SECRET) {
  GQL_HEADERS["X-Proxy-Secret"] = process.env.TS_PROXY_SECRET
}

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
  EDITION METADATA BACKFILL COMPLETE
  Total editions:  ${editions.length}
  Updated:         ${updated}
  Skipped (no moment): ${skipped}
  GQL failures:    ${gqlFails}
  Elapsed:         ${elapsed}s
════════════════════════════════════════`)
}

main().catch(err => {
  console.error("Fatal:", err)
  process.exit(1)
})
