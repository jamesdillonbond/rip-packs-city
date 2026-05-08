#!/usr/bin/env node
// scripts/seed-topshot-editions-from-sets.ts
//
// Seeds the editions table for TopShot integer-format editions when the
// existing enrich-topshot-editions.ts --integer pass can't fix gaps because
// the rows don't exist yet at all. This is a SEED, not an ENRICH — it INSERTs
// new editions rows keyed on external_id = '{setID}:{playID}'.
//
// Why this exists: 93,350 wallet_moments_cache rows reference 2,659 distinct
// edition_keys that have no corresponding editions row. Verified 2026-05-07
// — top affected sets (by missing-edition count): 218, 5, 29, 54, 28, 53,
// 99, 188, 231, 131, 169, 103, 163, 143, 233.
//
// What this script does, per setID in --sets=...:
//   1. Cadence: TopShot.getPlaysInSet(setID) — enumerate all playIDs.
//   2. Cadence: TopShot.getPlayMetaData(playID) — pull metadata per play.
//   3. Cadence: TopShot.getSetSeries(setID) + getSetData(setID).tier —
//      pull series and tier in one shot. Tier is normalised to uppercase
//      without the MOMENT_TIER_ prefix (e.g. "COMMON", "RARE",
//      "LEGENDARY", "FANDOM", "ULTIMATE") to match the existing
//      editions.tier column convention used by enrich-topshot-editions.ts.
//   4. INSERT-or-skip into editions(external_id='{setID}:{playID}',
//      collection_id=TS UUID, player_name=FullName, team_name=TeamAtMoment,
//      play_type=PlayCategory, game_date=DateOfMoment::date,
//      series=<int>, tier=<TIER>, set_id_onchain=setID,
//      play_id_onchain=playID, name='{FullName} — {SetName}',
//      set_name=<set name from getSetData>).
//
// What this script does NOT do: thumbnail_url (not on-chain).
// Run this first, then run enrich-topshot-editions.ts to fill that.
//
// Tier capture (added 2026-05-08): the prior version left tier NULL.
// Re-running for the 139 outstanding setIDs after this patch will populate
// tier on the freshly-inserted rows; existing rows are not rewritten
// because the upsert uses ignoreDuplicates: true.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/seed-topshot-editions-from-sets.ts --sets=218,5,29
//   Optional: --dry-run to preview without writing.
//   Optional: --concurrency=4 (default 2 — Flow access node is rate-limited).
//   Optional: --skip-existing (default true — does INSERT … ON CONFLICT DO NOTHING)

import { createClient } from "@supabase/supabase-js"
import * as fcl from "@onflow/fcl"
import * as t from "@onflow/types"

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co"
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const DRY_RUN = process.argv.includes("--dry-run")
const SETS = (() => {
  const hit = process.argv.find((a) => a.startsWith("--sets="))
  if (!hit) return [] as number[]
  return hit
    .slice("--sets=".length)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
})()
const CONCURRENCY = (() => {
  const hit = process.argv.find((a) => a.startsWith("--concurrency="))
  const n = hit ? Number(hit.slice("--concurrency=".length)) : 2
  return Number.isFinite(n) && n >= 1 && n <= 8 ? n : 2
})()
const PER_CALL_DELAY_MS = 100

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set")
  process.exit(1)
}
if (SETS.length === 0) {
  console.error("--sets=... is required (comma-separated setIDs, e.g. --sets=218,5,29)")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

fcl.config()
  .put("flow.network", "mainnet")
  .put("accessNode.api", "https://rest-mainnet.onflow.org")

const SERIES_MAP: Record<number, string> = {
  0: "Series 1",
  2: "Series 2",
  3: "Summer 2021",
  4: "Series 3",
  5: "Series 4",
  6: "Series 2023-24",
  7: "Series 2024-25",
  8: "Series 2025-26",
}

const CADENCE_GET_PLAYS_IN_SET = `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(setID: UInt32): [UInt32] {
  return TopShot.getPlaysInSet(setID: setID) ?? []
}
`.trim()

const CADENCE_GET_PLAY_META = `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(playID: UInt32): {String: String} {
  return TopShot.getPlayMetaData(playID: playID) ?? {}
}
`.trim()

// Pulls name + series + tier in one round-trip. Tier is taken from
// TopShot.getSetData(setID: setID).tier — modern TopShot mainnet exposes
// tier on QuerySetData (per-set, since each TS Set has a single tier).
// We do an optional-chained access so a setID with no on-chain SetData
// still returns a usable result rather than panicking.
const CADENCE_GET_SET_INFO = `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(setID: UInt32): {String: String} {
  let name = TopShot.getSetName(setID: setID) ?? ""
  let series = TopShot.getSetSeries(setID: setID)
  let setData = TopShot.getSetData(setID: setID)
  var tier = ""
  if setData != nil {
    tier = setData!.tier ?? ""
  }
  return {
    "name": name,
    "series": series == nil ? "" : series!.toString(),
    "tier": tier
  }
}
`.trim()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function getPlaysInSet(setID: number): Promise<number[]> {
  const r = (await fcl.query({
    cadence: CADENCE_GET_PLAYS_IN_SET,
    args: (arg: any) => [arg(String(setID), t.UInt32)],
  })) as Array<string | number>
  return (r ?? []).map((p) => Number(p)).filter((n) => Number.isFinite(n))
}

async function getPlayMeta(playID: number): Promise<Record<string, string>> {
  const r = (await fcl.query({
    cadence: CADENCE_GET_PLAY_META,
    args: (arg: any) => [arg(String(playID), t.UInt32)],
  })) as Record<string, string> | null
  return r ?? {}
}

async function getSetInfo(
  setID: number,
): Promise<{ name: string; series: number | null; tier: string | null }> {
  const r = (await fcl.query({
    cadence: CADENCE_GET_SET_INFO,
    args: (arg: any) => [arg(String(setID), t.UInt32)],
  })) as Record<string, string>
  const series = Number(r.series)
  // Normalise tier to match enrich-topshot-editions.ts convention: strip
  // any MOMENT_TIER_ prefix and uppercase. Empty/whitespace → null so the
  // INSERT writes NULL rather than a literal "" string.
  const rawTier = (r.tier ?? "").trim()
  const tier = rawTier
    ? rawTier.replace(/^MOMENT_TIER_/i, "").toUpperCase()
    : null
  return {
    name: r.name ?? "",
    series: Number.isFinite(series) ? series : null,
    tier,
  }
}

interface EditionRow {
  external_id: string
  collection_id: string
  name: string
  player_name: string | null
  team_name: string | null
  play_type: string | null
  game_date: string | null
  series: number | null
  tier: string | null
  set_id_onchain: number
  play_id_onchain: number
  set_name: string
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function run() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i])
      if (PER_CALL_DELAY_MS > 0) await sleep(PER_CALL_DELAY_MS)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()))
  return results
}

async function processSet(setID: number): Promise<{ inserted: number; skipped: number; errors: number }> {
  const setInfo = await getSetInfo(setID)
  if (!setInfo.name) {
    console.warn(`[seed-topshot] setID=${setID} has no name on chain — skipping`)
    return { inserted: 0, skipped: 0, errors: 1 }
  }
  const playIDs = await getPlaysInSet(setID)
  console.log(
    `[seed-topshot] setID=${setID} (${setInfo.name}) tier=${setInfo.tier ?? "null"} has ${playIDs.length} plays on chain`,
  )

  const metas = await mapWithConcurrency(playIDs, CONCURRENCY, getPlayMeta)
  const rows: EditionRow[] = []
  for (let i = 0; i < playIDs.length; i++) {
    const playID = playIDs[i]
    const m = metas[i] ?? {}
    const fullName = (m["FullName"] ?? "").trim()
    const team = (m["TeamAtMoment"] ?? "").trim()
    const playCategory = (m["PlayCategory"] ?? "").trim()
    const dateOfMoment = (m["DateOfMoment"] ?? "").trim()
    const externalId = `${setID}:${playID}`
    rows.push({
      external_id: externalId,
      collection_id: TOPSHOT_COLLECTION_ID,
      name: fullName ? `${fullName} — ${setInfo.name}` : setInfo.name,
      player_name: fullName || null,
      team_name: team || null,
      play_type: playCategory || null,
      game_date: dateOfMoment ? dateOfMoment.slice(0, 10) : null,
      series: setInfo.series,
      tier: setInfo.tier,
      set_id_onchain: setID,
      play_id_onchain: playID,
      set_name: setInfo.name,
    })
  }

  if (DRY_RUN) {
    console.log(`[seed-topshot] DRY RUN setID=${setID} would upsert ${rows.length} rows. Sample:`)
    console.log(JSON.stringify(rows.slice(0, 3), null, 2))
    return { inserted: 0, skipped: rows.length, errors: 0 }
  }

  // INSERT … ON CONFLICT DO NOTHING via supabase-js: use upsert with
  // ignoreDuplicates so existing rows aren't overwritten by the seed pass.
  const { data, error } = await (supabase as any)
    .from("editions")
    .upsert(rows, { onConflict: "external_id,collection_id", ignoreDuplicates: true })
    .select("external_id")
  if (error) {
    console.error(`[seed-topshot] setID=${setID} upsert error: ${error.message}`)
    return { inserted: 0, skipped: 0, errors: 1 }
  }
  const inserted = data?.length ?? 0
  console.log(`[seed-topshot] setID=${setID} inserted=${inserted} (skipped existing=${rows.length - inserted})`)
  return { inserted, skipped: rows.length - inserted, errors: 0 }
}

async function main() {
  console.log(`[seed-topshot] sets=${SETS.join(",")} concurrency=${CONCURRENCY} dry_run=${DRY_RUN}`)
  let totalInserted = 0
  let totalSkipped = 0
  let totalErrors = 0
  for (const setID of SETS) {
    try {
      const r = await processSet(setID)
      totalInserted += r.inserted
      totalSkipped += r.skipped
      totalErrors += r.errors
    } catch (err) {
      totalErrors++
      console.error(`[seed-topshot] setID=${setID} fatal: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(`[seed-topshot] DONE inserted=${totalInserted} skipped=${totalSkipped} errors=${totalErrors}`)
  console.log(
    `\nNext step: npx tsx scripts/enrich-topshot-editions.ts --integer --limit=500 to fill thumbnail_url + tier on the freshly seeded rows.`,
  )
}

main().catch((err) => {
  console.error("[seed-topshot] FATAL", err)
  process.exit(1)
})
