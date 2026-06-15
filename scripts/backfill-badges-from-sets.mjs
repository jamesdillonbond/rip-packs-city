#!/usr/bin/env node
/**
 * scripts/backfill-badges-from-sets.mjs
 *
 * One-off bulk runner for the set-driven badge backfill (mirrors the durable
 * route app/api/admin/backfill-badges-from-sets). Fills badge_editions rows for
 * the canonical Top Shot editions the catalog sweep (searchMarketplaceEditions)
 * structurally misses — rare/Ultimate trophy editions (Supernova/Skyline/…) —
 * by querying searchEditions(filters:{bySetIDs:[<setUUID>]}), which returns the
 * FULL catalog per set incl. play.tags / setPlay.tags.
 *
 * Direct public-api GQL works from a dev box (Cloudflare only blocks Vercel /
 * Supabase egress). Writes via the service key in .env.local.
 *
 * Usage:
 *   node scripts/backfill-badges-from-sets.mjs          # write
 *   node scripts/backfill-badges-from-sets.mjs --dry    # compute only
 *   node scripts/backfill-badges-from-sets.mjs --set=165 # one on-chain set id
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const COLLECTION_SLUG = "nba_top_shot"
const TS_GQL = "https://public-api.nbatopshot.com/graphql"

const BADGE = {
  ROOKIE_YEAR: "2dbd4eef-4417-451b-b645-90f02574a401",
  ROOKIE_PREMIERE: "0ddb2c58-4385-443b-9c70-239b32cddbd4",
  TOP_SHOT_DEBUT: "a75e247a-ecbf-45a6-b1be-58bb07a1b651",
  ROOKIE_OF_THE_YEAR: "34fe8d3f-681a-42df-856a-e98624f95b11",
  ROOKIE_MINT: "24d515af-e967-45f5-a30e-11fc96dc2b62",
  CHAMPIONSHIP_YEAR: "f197f60a-b502-4386-b0c0-7f4cde8164ff",
  INTERACTIVE: "9bbb6f91-d09a-4d07-ab3d-8402a9c10cf1",
}

const DRY = process.argv.includes("--dry")
const ONLY_SET = (process.argv.find((a) => a.startsWith("--set=")) || "").split("=")[1] || null

// ---- env -------------------------------------------------------------------
function parseEnvLocal() {
  const out = {}
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}
const env = parseEnvLocal()
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Missing Supabase creds in .env.local")
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- helpers (mirror the route) --------------------------------------------
function computeBadgeScore(pIds, sIds) {
  let score = 0
  if (pIds.has(BADGE.ROOKIE_YEAR)) score += 1
  if (pIds.has(BADGE.ROOKIE_PREMIERE)) score += 1
  if (pIds.has(BADGE.TOP_SHOT_DEBUT)) score += 1
  if (sIds.has(BADGE.ROOKIE_MINT)) score += 1
  const threeStar = pIds.has(BADGE.ROOKIE_YEAR) && pIds.has(BADGE.ROOKIE_PREMIERE) && pIds.has(BADGE.TOP_SHOT_DEBUT)
  if (threeStar && sIds.has(BADGE.ROOKIE_MINT)) score += 4
  if (pIds.has(BADGE.ROOKIE_OF_THE_YEAR)) score += 3
  if (pIds.has(BADGE.CHAMPIONSHIP_YEAR)) score += 2
  return score
}
function intLike(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (!/^\d+$/.test(s) || s === "0") return null
  return s
}
function editionKey(e, setMap) {
  const playStr = intLike(e.play?.flowID) ?? intLike(e.play?.id)
  let setStr = e.set?.id ? (setMap.get(e.set.id) ?? null) : null
  if (!setStr) setStr = intLike(e.set?.flowId) ?? intLike(e.set?.id)
  if (!setStr || !playStr) return null
  return `${setStr}:${playStr}`
}
function tagList(tags) {
  return (tags ?? []).filter((t) => t.visible && t.id !== BADGE.INTERACTIVE).map((t) => ({ id: t.id, title: t.title }))
}
function normalize(e, key) {
  const playTags = tagList(e.play?.tags)
  const setPlayTags = tagList(e.setPlay?.tags)
  const pIds = new Set(playTags.map((t) => t.id))
  const sIds = new Set(setPlayTags.map((t) => t.id))
  const circ = e.setPlay?.circulations ?? null
  const totalCirc = circ?.circulationCount ?? e.circulationCount ?? 0
  const burned = circ?.burned ?? 0
  const locked = circ?.locked ?? 0
  const owned = circ?.ownedByCollectors ?? 0
  return {
    id: e.id || key,
    collection_id: COLLECTION_ID,
    collection: COLLECTION_SLUG,
    external_id: key,
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
    parallel_name: "Standard",
    play_tags: playTags,
    set_play_tags: setPlayTags,
    is_three_star_rookie: pIds.has(BADGE.ROOKIE_YEAR) && pIds.has(BADGE.ROOKIE_PREMIERE) && pIds.has(BADGE.TOP_SHOT_DEBUT),
    has_rookie_mint: sIds.has(BADGE.ROOKIE_MINT),
    badge_score: computeBadgeScore(pIds, sIds),
    circulation_count: totalCirc,
    effective_supply: circ?.effectiveSupply ?? null,
    burned,
    locked,
    owned,
    hidden_in_packs: circ?.hiddenInPacks ?? null,
    burn_rate_pct: totalCirc > 0 ? Number(((burned / totalCirc) * 100).toFixed(1)) : 0,
    lock_rate_pct: owned > 0 ? Number(((locked / owned) * 100).toFixed(1)) : 0,
    flow_retired: e.setPlay?.flowRetired ?? false,
    updated_at: new Date().toISOString(),
  }
}

async function fetchAll(table, columns, applyFilters) {
  const out = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await applyFilters(
      supabase.from(table).select(columns).order("external_id", { ascending: true }),
    ).range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data ?? []))
    if ((data ?? []).length < PAGE) break
  }
  return out
}

const SET_QUERY = `query BadgeBySet($input: SearchEditionsInput!) {
  searchEditions(input: $input) { searchSummary { data { ... on Editions { data { ... on Edition {
    id tier parallelID
    set { id flowId flowName flowSeriesNumber }
    play { id flowID stats { playerName teamAtMoment teamAtMomentNbaId nbaSeason playerID } tags { id title visible } }
    setPlay { ID flowRetired tags { id title visible } circulations { burned circulationCount forSaleByCollectors hiddenInPacks ownedByCollectors locked effectiveSupply } }
    circulationCount
  } } } } } } }`

async function fetchSetEditions(setUuid) {
  const res = await fetch(TS_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "sports-collectible-tool/0.1" },
    body: JSON.stringify({
      query: SET_QUERY,
      variables: { input: { filters: { bySetIDs: [setUuid] }, searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 500 } } } },
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`GQL ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "))
  return json?.data?.searchEditions?.searchSummary?.data?.data ?? []
}

async function main() {
  // 1. missing editions
  const edRows = await fetchAll("editions", "external_id, set_id_onchain", (q) =>
    q.eq("collection_id", COLLECTION_ID).not("set_id_onchain", "is", null))
  const badgeRows = await fetchAll("badge_editions", "external_id", (q) => q.eq("collection_id", COLLECTION_ID))
  const haveBadge = new Set(badgeRows.map((b) => b.external_id).filter(Boolean))
  const missing = []
  for (const e of edRows) {
    if (!e.external_id || e.set_id_onchain == null) continue
    if (!/^[0-9]+:[0-9]+$/.test(e.external_id)) continue
    if (haveBadge.has(e.external_id)) continue
    missing.push({ external_id: e.external_id, set_id_onchain: e.set_id_onchain })
  }

  // 2. set uuid map
  const setMap = new Map() // gqlSetUUID is the value keyed by gqlSetUUID for editionKey; also intToUuid below
  const intToUuid = new Map()
  const setTbl = await fetchAll("sets", "external_id, set_id_onchain", (q) =>
    q.eq("collection_id", COLLECTION_ID).not("set_id_onchain", "is", null))
  for (const r of setTbl) {
    if (r.external_id && /^[0-9a-f-]{36}$/.test(r.external_id) && r.set_id_onchain != null) {
      intToUuid.set(String(r.set_id_onchain), r.external_id)
      setMap.set(r.external_id, String(r.set_id_onchain))
    }
  }
  const sibTbl = await fetchAll("badge_editions", "external_id, set_id", (q) =>
    q.eq("collection_id", COLLECTION_ID).not("set_id", "is", null))
  for (const r of sibTbl) {
    if (!r.external_id || !r.set_id) continue
    const intId = r.external_id.split(":")[0]
    if (/^\d+$/.test(intId) && /^[0-9a-f-]{36}$/.test(r.set_id)) {
      if (!intToUuid.has(intId)) intToUuid.set(intId, r.set_id)
      if (!setMap.has(r.set_id)) setMap.set(r.set_id, intId)
    }
  }

  // 3. group missing by set
  const bySet = new Map()
  for (const m of missing) {
    const intId = String(m.set_id_onchain)
    if (ONLY_SET && intId !== ONLY_SET) continue
    if (!bySet.has(intId)) bySet.set(intId, new Set())
    bySet.get(intId).add(m.external_id)
  }
  const reachable = []
  const unreachable = []
  for (const intId of bySet.keys()) (intToUuid.has(intId) ? reachable : unreachable).push(intId)

  const missingKeys = new Set(missing.map((m) => m.external_id))
  const rowsByKey = new Map()
  let setsQueried = 0
  for (const intId of reachable) {
    const setUuid = intToUuid.get(intId)
    const wanted = bySet.get(intId)
    try {
      const eds = await fetchSetEditions(setUuid)
      setsQueried++
      for (const e of eds) {
        const key = editionKey(e, setMap)
        if (!key || !missingKeys.has(key) || !wanted.has(key)) continue
        if (!rowsByKey.has(key)) rowsByKey.set(key, normalize(e, key))
      }
      process.stdout.write(`  set ${intId}: ${eds.length} editions, matched ${[...wanted].filter((k) => rowsByKey.has(k)).length}/${wanted.size}\n`)
    } catch (err) {
      process.stdout.write(`  set ${intId} ERROR: ${err.message}\n`)
    }
    await sleep(200)
  }

  const rows = [...rowsByKey.values()]
  const kd = rows.find((r) => r.external_id === "165:6563")
  console.log(`\nmissing=${missing.length} reachableSets=${reachable.length} unreachableSets=${unreachable.length} setsQueried=${setsQueried} computedRows=${rows.length}`)
  if (kd) console.log(`KD 165:6563 -> ${kd.play_tags.map((t) => t.title).join(", ")} (score ${kd.badge_score})`)
  if (unreachable.length) console.log(`unreachable set ids (no GQL uuid): ${unreachable.join(", ")}`)

  if (DRY) {
    console.log("\n--dry: no write. sample:")
    console.log(rows.slice(0, 8).map((r) => `${r.external_id} ${r.player_name} [${r.play_tags.map((t) => t.title).join(", ")}]`).join("\n"))
    return
  }

  let upserted = 0
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50)
    const { error } = await supabase.from("badge_editions").upsert(batch, { onConflict: "external_id,collection_id" })
    if (error) console.log(`  upsert batch ${i} error: ${error.message}`)
    else upserted += batch.length
    await sleep(150)
  }
  console.log(`\nDONE: upserted ${upserted} badge_editions rows`)
}

main().catch((e) => { console.error(e); process.exit(1) })
