#!/usr/bin/env node

/**
 * Targeted backfill for the residual TopShot UUID:UUID skeleton edition rows
 * that the standard rehydrate script can't resolve.
 *
 * Why a second script: SearchEditionBackfill (the GQL used by
 * scripts/rehydrate-null-topshot-editions.mjs) returns the row's metadata
 * (playerName, set.flowName, tier, etc.) but for some UUID lookups it leaves
 * set.flowId / play.flowID as NULL — Top Shot's API doesn't expose the
 * integer on-chain IDs for those editions through that query. This script
 * uses searchMomentListings.byEditions instead, which carries
 * `moment.setPlay.{setID, playID}` as integers because they come from a
 * real listing on chain. Same proxy / auth surface; just a different
 * resolver path for the same gap.
 *
 * Cohort filter is intentionally narrow: TopShot editions where external_id
 * is UUID:UUID AND set_id_onchain IS NULL (so we never touch already-resolved
 * rows or integer-pair stubs that go through topshot-stub-resolver).
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-topshot-onchain-ids-from-uuids.mjs --dry-run
 *   node --env-file=.env.local scripts/backfill-topshot-onchain-ids-from-uuids.mjs
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

const SEARCH_BY_EDITION = `
  query SearchByEdition($setID: String!, $playID: String!) {
    searchMomentListings(
      input: {
        filters: { byEditions: [{ setID: $setID, playID: $playID }] }
        sortBy: { field: UPDATED_AT, direction: DESC }
        pagination: { cursor: "", direction: AFTER, limit: 1 }
      }
    ) {
      data {
        moment {
          flowRetired
          setPlay { setID playID }
        }
      }
    }
  }
`

async function tsGql(query, variables, operationName) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/uuid-backfill",
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

async function resolvePair(setUuid, playUuid) {
  const data = await tsGql(
    SEARCH_BY_EDITION,
    { setID: setUuid, playID: playUuid },
    "SearchByEdition",
  )
  const sp = data?.searchMomentListings?.data?.[0]?.moment?.setPlay
  if (!sp) return null
  const setIdOnchain = parseInt(sp.setID, 10)
  const playIdOnchain = parseInt(sp.playID, 10)
  if (!Number.isFinite(setIdOnchain) || !Number.isFinite(playIdOnchain)) return null
  return { setIdOnchain, playIdOnchain }
}

async function loadCohort() {
  // UUID:UUID TopShot editions still missing set_id_onchain. Paginated to
  // avoid PostgREST's default cap; this script only writes once per row so
  // re-running is idempotent (the .is("set_id_onchain", null) filter on the
  // update prevents stomping rows hydrated by another path between runs).
  const all = []
  const PAGE = 1000
  for (let from = 0; from < 10_000; from += PAGE) {
    const { data, error } = await supabase
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", TS_COLLECTION_ID)
      .is("set_id_onchain", null)
      .like("external_id", "%-%-%-%-%:%-%-%-%-%")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`cohort load: ${error.message}`)
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < PAGE) break
  }
  // Belt-and-braces UUID:UUID format check (the LIKE above is a loose filter)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return all.filter((r) => UUID_RE.test(r.external_id))
}

async function main() {
  const start = Date.now()
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"}`)
  console.log(`TS proxy: ${TS_PROXY_URL}`)

  const cohort = await loadCohort()
  console.log(`Cohort size: ${cohort.length} (UUID:UUID rows with NULL set_id_onchain)`)
  if (cohort.length === 0) return

  const tickMs = Math.ceil(1000 / RATE_LIMIT_RPS)
  let updated = 0
  let unresolved = 0
  let updateErrs = 0
  const samples = []

  for (let i = 0; i < cohort.length; i++) {
    const row = cohort[i]
    const [setUuid, playUuid] = row.external_id.split(":")
    const resolved = await resolvePair(setUuid, playUuid)
    if (!resolved) {
      unresolved++
      if (samples.length < SAMPLE_LIMIT) {
        samples.push({ external_id: row.external_id, setIdOnchain: null, playIdOnchain: null })
      }
      await delay(tickMs)
      continue
    }

    if (DRY_RUN) {
      if (samples.length < SAMPLE_LIMIT) {
        samples.push({ external_id: row.external_id, ...resolved })
      }
      updated++
    } else {
      const { error } = await supabase
        .from("editions")
        .update({
          set_id_onchain: resolved.setIdOnchain,
          play_id_onchain: resolved.playIdOnchain,
        })
        .eq("id", row.id)
        .is("set_id_onchain", null)
      if (error) {
        updateErrs++
        if (samples.length < SAMPLE_LIMIT) {
          samples.push({ external_id: row.external_id, err: error.message.slice(0, 80) })
        }
      } else {
        updated++
      }
    }
    await delay(tickMs)
  }

  console.log(`\n═══ SUMMARY (${DRY_RUN ? "DRY" : "LIVE"}) ═══`)
  console.log(`  updated:      ${updated}`)
  console.log(`  unresolved:   ${unresolved}`)
  if (updateErrs > 0) console.log(`  update errs:  ${updateErrs}`)
  console.log(`  elapsed:      ${((Date.now() - start) / 1000).toFixed(1)}s`)
  if (samples.length > 0) {
    console.log(`\nFirst ${samples.length} samples:`)
    for (const s of samples) {
      console.log(`  ${s.external_id} → ${s.setIdOnchain ?? "<no resolve>"}:${s.playIdOnchain ?? "<no resolve>"}${s.err ? ` ERR: ${s.err}` : ""}`)
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
