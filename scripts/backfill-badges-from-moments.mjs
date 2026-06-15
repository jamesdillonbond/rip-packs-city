#!/usr/bin/env node
/**
 * scripts/backfill-badges-from-moments.mjs
 *
 * Fallback pass to backfill-badges-from-sets: for the canonical Top Shot
 * editions still missing a badge_editions row after the set sweep (editions
 * searchEditions(bySetIDs) doesn't return + the GQL-UUID-less sets), resolve a
 * known moment_id from wmc / moments / sales and read the edition's play-level
 * badges via getMintedMoment(momentId){ play{tags} setPlay{tags} } — the
 * EDITION badges (Rookie Year etc.), NOT the moment's serial badges
 * (SERIAL_NUMBER_ONE / PERFECT_MINT, which live on data.badges and must be
 * ignored here). external_id is already known from the seed lookup, so no
 * keying off the GQL response is needed.
 *
 * Usage:
 *   node scripts/backfill-badges-from-moments.mjs          # write
 *   node scripts/backfill-badges-from-moments.mjs --dry
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const COLLECTION_SLUG = "nba_top_shot"
const TS_GQL = "https://public-api.nbatopshot.com/graphql"
const DRY = process.argv.includes("--dry")

const BADGE = {
  ROOKIE_YEAR: "2dbd4eef-4417-451b-b645-90f02574a401",
  ROOKIE_PREMIERE: "0ddb2c58-4385-443b-9c70-239b32cddbd4",
  TOP_SHOT_DEBUT: "a75e247a-ecbf-45a6-b1be-58bb07a1b651",
  ROOKIE_OF_THE_YEAR: "34fe8d3f-681a-42df-856a-e98624f95b11",
  ROOKIE_MINT: "24d515af-e967-45f5-a30e-11fc96dc2b62",
  CHAMPIONSHIP_YEAR: "f197f60a-b502-4386-b0c0-7f4cde8164ff",
  INTERACTIVE: "9bbb6f91-d09a-4d07-ab3d-8402a9c10cf1",
}

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
const tagList = (tags) =>
  (tags ?? []).filter((t) => t.visible && t.id !== BADGE.INTERACTIVE).map((t) => ({ id: t.id, title: t.title }))

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

const MOMENT_QUERY = `query BadgeFromMoment($id: ID!) {
  getMintedMoment(momentId: $id) {
    data {
      id
      edition { id }
      play { id flowID tags { id title visible } }
      setPlay { tags { id title visible } }
    }
  }
}`

async function fetchMomentBadges(momentId) {
  const res = await fetch(TS_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "sports-collectible-tool/0.1" },
    body: JSON.stringify({ query: MOMENT_QUERY, variables: { id: String(momentId) } }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`GQL ${res.status}`)
  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "))
  return json?.data?.getMintedMoment?.data ?? null
}

const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o }

async function main() {
  // 1. still-missing editions (no badge row), with metadata for the row.
  const edRows = await fetchAll(
    "editions",
    "id, external_id, set_id_onchain, player_name, player_id, set_name, series, tier",
    (q) => q.eq("collection_id", COLLECTION_ID).not("set_id_onchain", "is", null),
  )
  const badgeRows = await fetchAll("badge_editions", "external_id", (q) => q.eq("collection_id", COLLECTION_ID))
  const haveBadge = new Set(badgeRows.map((b) => b.external_id).filter(Boolean))
  const missing = edRows.filter(
    (e) => e.external_id && /^[0-9]+:[0-9]+$/.test(e.external_id) && !haveBadge.has(e.external_id),
  )
  const byExt = new Map(missing.map((e) => [e.external_id, e]))
  const byId = new Map(missing.map((e) => [e.id, e]))

  // 2. seed moment_id per missing edition: wmc -> moments -> sales.
  const seed = new Map() // external_id -> moment_id
  // wmc (keyed by edition_key == external_id)
  for (const c of chunk(missing.map((m) => m.external_id), 200)) {
    const { data } = await supabase
      .from("wallet_moments_cache")
      .select("edition_key, moment_id")
      .eq("collection_id", COLLECTION_ID)
      .in("edition_key", c)
      .not("moment_id", "is", null)
      .limit(1000)
    for (const r of data ?? []) if (r.edition_key && r.moment_id && !seed.has(r.edition_key)) seed.set(r.edition_key, r.moment_id)
  }
  // moments + sales (keyed by edition_id uuid)
  const stillNoSeed = () => missing.filter((m) => !seed.has(m.external_id))
  for (const tbl of ["moments", "sales"]) {
    const remaining = stillNoSeed()
    if (!remaining.length) break
    for (const c of chunk(remaining.map((m) => m.id), 150)) {
      const { data } = await supabase
        .from(tbl)
        .select("edition_id, nft_id")
        .in("edition_id", c)
        .not("nft_id", "is", null)
        .limit(1000)
      for (const r of data ?? []) {
        const e = byId.get(r.edition_id)
        if (e && r.nft_id && !seed.has(e.external_id)) seed.set(e.external_id, r.nft_id)
      }
    }
  }

  console.log(`still-missing=${missing.length}  seed-resolved=${seed.size}`)

  // 3. getMintedMoment per seeded edition -> badge row.
  const rows = []
  let gqlFails = 0
  let withBadges = 0
  for (const [ext, momentId] of seed.entries()) {
    const meta = byExt.get(ext)
    try {
      const d = await fetchMomentBadges(momentId)
      const playTags = tagList(d?.play?.tags)
      const setPlayTags = tagList(d?.setPlay?.tags)
      const pIds = new Set(playTags.map((t) => t.id))
      const sIds = new Set(setPlayTags.map((t) => t.id))
      if (playTags.length || setPlayTags.length) withBadges++
      rows.push({
        id: d?.edition?.id || ext,
        collection_id: COLLECTION_ID,
        collection: COLLECTION_SLUG,
        external_id: ext,
        set_id: null,
        play_id: d?.play?.id ?? null,
        player_id: meta.player_id ?? null,
        player_name: meta.player_name ?? null,
        set_name: meta.set_name ?? null,
        series_number: meta.series ?? null,
        tier: meta.tier ?? null,
        parallel_id: 0,
        parallel_name: "Standard",
        play_tags: playTags,
        set_play_tags: setPlayTags,
        is_three_star_rookie: pIds.has(BADGE.ROOKIE_YEAR) && pIds.has(BADGE.ROOKIE_PREMIERE) && pIds.has(BADGE.TOP_SHOT_DEBUT),
        has_rookie_mint: sIds.has(BADGE.ROOKIE_MINT),
        badge_score: computeBadgeScore(pIds, sIds),
        flow_retired: false,
        updated_at: new Date().toISOString(),
      })
    } catch (err) {
      gqlFails++
      if (gqlFails <= 5) console.log(`  moment ${momentId} (${ext}) failed: ${err.message}`)
    }
    await sleep(120)
  }

  console.log(`computed=${rows.length}  with>=1 badge=${withBadges}  gqlFails=${gqlFails}`)
  const samples = rows.filter((r) => r.play_tags.length || r.set_play_tags.length).slice(0, 10)
  console.log(samples.map((r) => `${r.external_id} ${r.player_name ?? "—"} [${r.play_tags.map((t) => t.title).join(", ")}]`).join("\n"))

  if (DRY) { console.log("\n--dry: no write"); return }

  let upserted = 0
  for (const c of chunk(rows, 50)) {
    const { error } = await supabase.from("badge_editions").upsert(c, { onConflict: "external_id,collection_id" })
    if (error) console.log(`  upsert error: ${error.message}`)
    else upserted += c.length
    await sleep(150)
  }
  console.log(`\nDONE: upserted ${upserted} badge_editions rows (fallback)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
