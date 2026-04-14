#!/usr/bin/env node

/**
 * Catalog-based edition backfill.
 *
 * For every Top Shot edition in Supabase missing player_name / set_name / tier,
 * look up the owning set via its on-chain setID and pull all editions at once
 * using the Top Shot GQL searchEditions query. Match GQL results back to DB
 * rows via set_id_onchain + play_id_onchain, then fill in metadata.
 *
 * This avoids the per-moment getMintedMoment lookup that fails when no wallet
 * in our index owns a moment from the edition.
 *
 * Usage: node --env-file=.env.local scripts/backfill-editions-catalog.mjs
 */

import { readFileSync } from "fs"
import { createClient } from "@supabase/supabase-js"

// Fallback env loader for when --env-file isn't passed
try {
  const envContent = readFileSync(".env.local", "utf-8")
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim()
    }
  }
} catch { /* ignore */ }

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const DELAY_MS = 200
const PAGE_SIZE = 1000

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
  if (json.errors && json.errors.length) {
    throw new Error(json.errors[0].message)
  }
  return json.data
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

// Matches the shape documented in lib/topshot-graphql.ts, extended with the
// metadata fields we need. If a field is rejected at runtime, remove it.
const SEARCH_EDITIONS_QUERY = `
  query SearchEditions($setID: ID, $first: Int!) {
    searchEditions(input: { setID: $setID, first: $first }) {
      data {
        set {
          id
          flowName
          flowSeriesNumber
        }
        play {
          id
          stats {
            playerName
            teamAtMoment
          }
        }
        tier
        setPlay {
          circulationCount
        }
      }
    }
  }
`

function mapTier(raw) {
  if (!raw) return null
  const t = String(raw).toUpperCase().trim()
  // Top Shot GQL sometimes returns "COMMON_TIER" / "RARE_TIER" etc.
  return t.replace(/_TIER$/, "")
}

async function fetchEditions() {
  // Pull editions in pages — PostgREST caps each page at 1000.
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from("editions")
      .select("id, external_id, set_id, set_id_onchain, play_id_onchain, player_name, set_name, tier, series")
      .eq("collection_id", TOPSHOT_COLLECTION_ID)
      .is("player_name", null)
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error("editions select: " + error.message)
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
}

async function loadSetsIndex(setIds) {
  if (setIds.length === 0) return new Map()
  const map = new Map()
  // Chunk by 500 to stay under URL-length limits
  for (let i = 0; i < setIds.length; i += 500) {
    const chunk = setIds.slice(i, i + 500)
    const { data, error } = await supabase
      .from("sets")
      .select("id, set_id_onchain, name")
      .in("id", chunk)
    if (error) throw new Error("sets select: " + error.message)
    for (const s of data ?? []) {
      map.set(s.id, s)
    }
  }
  return map
}

async function main() {
  console.log("[backfill-editions-catalog] starting")

  const editions = await fetchEditions()
  console.log(`[backfill-editions-catalog] ${editions.length} editions missing player_name`)
  if (editions.length === 0) return

  // Group editions by set_id
  const bySet = new Map()
  const setIdsNeedingLookup = new Set()
  const orphans = []
  for (const e of editions) {
    if (e.set_id) {
      const bucket = bySet.get(e.set_id) ?? []
      bucket.push(e)
      bySet.set(e.set_id, bucket)
      setIdsNeedingLookup.add(e.set_id)
    } else {
      orphans.push(e)
    }
  }
  console.log(`[backfill-editions-catalog] ${bySet.size} unique sets, ${orphans.length} editions with null set_id (skipped)`)

  const setsIndex = await loadSetsIndex(Array.from(setIdsNeedingLookup))

  let setsProcessed = 0
  let setsSkipped = 0
  let editionsUpdated = 0
  let editionsStillMissing = 0
  let gqlErrors = 0

  for (const [setUuid, dbEditions] of bySet.entries()) {
    const setRow = setsIndex.get(setUuid)
    const onchainSetId = setRow?.set_id_onchain
    if (!onchainSetId) {
      setsSkipped++
      editionsStillMissing += dbEditions.length
      continue
    }

    let gqlEditions = []
    try {
      const data = await topshotGql(SEARCH_EDITIONS_QUERY, {
        setID: String(onchainSetId),
        first: 500,
      })
      gqlEditions = data?.searchEditions?.data ?? []
    } catch (err) {
      gqlErrors++
      console.warn(`[backfill-editions-catalog] GQL failed for setID=${onchainSetId}: ${err.message}`)
      editionsStillMissing += dbEditions.length
      setsProcessed++
      await delay(DELAY_MS)
      continue
    }

    // Build playID -> gql edition index
    const byPlay = new Map()
    for (const ge of gqlEditions) {
      const pid = ge?.play?.id
      if (pid) byPlay.set(String(pid), ge)
    }

    // Also index by "setID:playID" so we can match external_id format
    const byKey = new Map()
    for (const ge of gqlEditions) {
      const sid = ge?.set?.id
      const pid = ge?.play?.id
      if (sid && pid) byKey.set(`${sid}:${pid}`, ge)
    }

    for (const e of dbEditions) {
      let ge = null
      if (e.play_id_onchain != null) {
        ge = byPlay.get(String(e.play_id_onchain)) ?? null
      }
      if (!ge && typeof e.external_id === "string") {
        ge = byKey.get(e.external_id) ?? null
      }
      if (!ge) {
        editionsStillMissing++
        continue
      }

      const playerName = ge?.play?.stats?.playerName ?? null
      const setName = ge?.set?.flowName ?? null
      const tier = mapTier(ge?.tier)
      const series = ge?.set?.flowSeriesNumber != null ? Number(ge.set.flowSeriesNumber) : null

      const patch = {}
      if (playerName && !e.player_name) patch.player_name = playerName
      if (setName && !e.set_name) patch.set_name = setName
      if (tier && !e.tier) patch.tier = tier
      if (series != null && e.series == null) patch.series = series

      if (Object.keys(patch).length === 0) {
        editionsStillMissing++
        continue
      }

      const { error: upErr } = await supabase
        .from("editions")
        .update(patch)
        .eq("id", e.id)
      if (upErr) {
        console.warn(`[backfill-editions-catalog] update failed for edition ${e.id}: ${upErr.message}`)
        editionsStillMissing++
      } else {
        editionsUpdated++
      }
    }

    setsProcessed++
    if (setsProcessed % 10 === 0) {
      console.log(
        `[backfill-editions-catalog] progress: sets=${setsProcessed}/${bySet.size} updated=${editionsUpdated} stillMissing=${editionsStillMissing}`
      )
    }
    await delay(DELAY_MS)
  }

  console.log("[backfill-editions-catalog] done")
  console.log(JSON.stringify({
    setsProcessed,
    setsSkipped,
    editionsScanned: editions.length,
    editionsUpdated,
    editionsStillMissing,
    gqlErrors,
  }, null, 2))
}

main().catch((err) => {
  console.error("[backfill-editions-catalog] fatal:", err)
  process.exit(1)
})
