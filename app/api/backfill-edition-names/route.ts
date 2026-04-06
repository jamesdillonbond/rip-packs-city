import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"

/**
 * POST /api/backfill-edition-names
 *
 * Backfills stub editions (external_id "setId:playId", name IS NULL) by
 * querying the TopShot smart contract on Flow mainnet via FCL Cadence scripts.
 * Auth: Bearer INGEST_SECRET_TOKEN. Processes up to 200 per run.
 */

export const maxDuration = 60

// ── Cadence scripts ─────────────────────────────────────────────────────────

async function getPlayMetaData(playId: number): Promise<Record<string, string>> {
  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all) fun main(playID: UInt32): {String: String} {
      return TopShot.getPlayMetaData(playID: playID) ?? {}
    }
  `
  const result = await fcl.query({ cadence, args: (arg: any) => [arg(String(playId), t.UInt32)] })
  return (result as Record<string, string>) ?? {}
}

async function getSetName(setId: number): Promise<string> {
  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all) fun main(setID: UInt32): String {
      return TopShot.getSetName(setID: setID) ?? ""
    }
  `
  const result = await fcl.query({ cadence, args: (arg: any) => [arg(String(setId), t.UInt32)] })
  return (result as string) ?? ""
}

// Cache circulation count per setID+playID
const circulationCache = new Map<string, number>()

async function getNumMomentsInEdition(setId: number, playId: number): Promise<number> {
  const cacheKey = setId + ":" + playId
  if (circulationCache.has(cacheKey)) return circulationCache.get(cacheKey)!

  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all) fun main(setID: UInt32, playID: UInt32): UInt32 {
      return TopShot.getNumMomentsInEdition(setID: setID, playID: playID) ?? 0
    }
  `
  const result = await fcl.query({
    cadence,
    args: (arg: any) => [arg(String(setId), t.UInt32), arg(String(playId), t.UInt32)],
  })
  const count = Number(result) || 0
  circulationCache.set(cacheKey, count)
  return count
}

// Cache setId → { name, series } since many editions share the same set
const setCache = new Map<number, { name: string; series: number }>()

async function getSetInfo(setId: number): Promise<{ name: string; series: number }> {
  if (setCache.has(setId)) return setCache.get(setId)!

  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all) fun main(setID: UInt32): UInt32 {
      return TopShot.getSetSeries(setID: setID) ?? 0
    }
  `
  const [name, seriesRaw] = await Promise.all([
    getSetName(setId),
    fcl.query({ cadence, args: (arg: any) => [arg(String(setId), t.UInt32)] }),
  ])
  const series = Number(seriesRaw) || 0
  const info = { name, series }
  setCache.set(setId, info)
  return info
}

function formatTier(meta: Record<string, string>): string | null {
  // Play metadata may have a "Tier" or "MomentTier" field
  const raw = meta.Tier || meta.tier || meta.MomentTier || meta.momentTier || null
  if (!raw) return null
  const upper = raw.toUpperCase().replace(/^MOMENT_TIER_/, "")
  if (upper.includes("LEGENDARY")) return "LEGENDARY"
  if (upper.includes("RARE")) return "RARE"
  if (upper.includes("ULTIMATE")) return "ULTIMATE"
  if (upper.includes("FANDOM")) return "FANDOM"
  if (upper.includes("COMMON")) return "COMMON"
  return upper
}

// ── Main route handler ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== "Bearer " + process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  // Step 1: Fetch stub editions from Supabase
  const { data: stubs, error: queryErr } = await (supabaseAdmin as any)
    .from("editions")
    .select("id, external_id")
    .is("name", null)
    .filter("external_id", "match", "^\\d+:\\d+$")
    .limit(200)

  if (queryErr) {
    return NextResponse.json({ error: "query error: " + queryErr.message }, { status: 500 })
  }

  const editionsToFill = stubs ?? []

  if (editionsToFill.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, failed: 0, remaining: 0 })
  }

  let updated = 0
  let failed = 0
  const sampleErrors: string[] = []

  // Step 2: Process in batches of 10 concurrent
  for (let i = 0; i < editionsToFill.length; i += 10) {
    const batch = editionsToFill.slice(i, i + 10)
    const results = await Promise.all(
      batch.map(async function (e: any) {
        const [setIdStr, playIdStr] = e.external_id.split(":")
        const setId = Number(setIdStr)
        const playId = Number(playIdStr)
        try {
          const [playMeta, setInfo, circulationCount] = await Promise.all([
            getPlayMetaData(playId),
            getSetInfo(setId),
            getNumMomentsInEdition(setId, playId),
          ])

          const playerName = playMeta.FullName || playMeta.PlayerName || playMeta.fullName || ""
          if (!playerName) {
            return { id: e.id, ek: e.external_id, error: "no FullName in play metadata (keys: " + Object.keys(playMeta).join(",") + ")" }
          }

          const name = playerName + " — " + (setInfo.name || "Unknown Set")
          const tier = formatTier(playMeta)
          const series = setInfo.series

          // Extract additional play metadata
          const play_category = playMeta.PlayCategory || playMeta.playCategory || null
          const play_type = playMeta.PlayType || playMeta.playType || null
          const home_team = playMeta.TeamAtMoment || playMeta.teamAtMoment || playMeta.HomeTeamName || playMeta.homeTeamName || null
          const away_team = playMeta.AwayTeamName || playMeta.awayTeamName || null
          const rawDate = playMeta.DateOfMoment || playMeta.dateOfMoment || null
          const game_date = rawDate || null // stored as text, Supabase will parse date format

          return {
            id: e.id, ek: e.external_id, name, tier, series,
            play_category, play_type, home_team, away_team, game_date,
            circulation_count: circulationCount > 0 ? circulationCount : null,
            error: null,
          }
        } catch (err) {
          return { id: e.id, ek: e.external_id, error: err instanceof Error ? err.message : String(err) }
        }
      })
    )

    for (const r of results) {
      if (r.error || !r.name) {
        failed++
        if (sampleErrors.length < 5) {
          sampleErrors.push(r.ek + ": " + (r.error || "no name"))
        }
        continue
      }
      // Build update payload — only include non-null new fields to avoid overwriting existing values
      const updatePayload: Record<string, unknown> = { name: r.name, tier: r.tier, series: r.series }
      if (r.play_category) updatePayload.play_category = r.play_category
      if (r.play_type) updatePayload.play_type = r.play_type
      if (r.home_team) updatePayload.home_team = r.home_team
      if (r.away_team) updatePayload.away_team = r.away_team
      if (r.game_date) updatePayload.game_date = r.game_date
      if (r.circulation_count) updatePayload.circulation_count = r.circulation_count

      const { error: upErr } = await (supabaseAdmin as any)
        .from("editions")
        .update(updatePayload)
        .eq("id", r.id)
      if (upErr) {
        failed++
        if (sampleErrors.length < 5) {
          sampleErrors.push(r.ek + ": db update — " + upErr.message)
        }
      } else {
        updated++
      }
    }
  }

  // Step 3: Count remaining stubs
  const { count: remaining } = await (supabaseAdmin as any)
    .from("editions")
    .select("id", { count: "exact", head: true })
    .is("name", null)
    .filter("external_id", "match", "^\\d+:\\d+$")

  return NextResponse.json({
    ok: true,
    stubs_found: editionsToFill.length,
    updated,
    failed,
    remaining: remaining ?? 0,
    sample_errors: sampleErrors,
  })
}
