import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"

/**
 * POST /api/backfill-edition-names
 *
 * Backfills editions missing metadata (play_category, game_date, circulation_count)
 * by querying the TopShot smart contract on Flow mainnet via FCL Cadence scripts.
 * Also fills name/tier/series if still null.
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

  // Step 1: Fetch editions missing metadata fields
  const { data: stubs, error: queryErr } = await (supabaseAdmin as any)
    .from("editions")
    .select("id, external_id, name, tier, series")
    .or("play_category.is.null,circulation_count.is.null,game_date.is.null")
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

          // Build update payload — preserve existing name/tier/series if already set
          const update: Record<string, any> = {}

          if (!e.name && playerName) {
            update.name = playerName + " — " + (setInfo.name || "Unknown Set")
          }
          if (e.tier == null) {
            const tier = formatTier(playMeta)
            if (tier) update.tier = tier
          }
          if (e.series == null) {
            update.series = setInfo.series
          }

          // New metadata fields — always set if we have data
          const playCategory = playMeta.PlayCategory || playMeta.playCategory || null
          const playType = playMeta.PlayType || playMeta.playType || null
          const rawDate = playMeta.DateOfMoment || playMeta.dateOfMoment || null
          const dateSlice = rawDate ? rawDate.slice(0, 10) : null
          const gameDate = dateSlice && /^\d{4}-\d{2}-\d{2}$/.test(dateSlice) ? dateSlice : null
          const homeTeam = playMeta.TeamAtMoment || playMeta.teamAtMoment || playMeta.HomeTeamName || playMeta.homeTeamName || null
          const awayTeam = playMeta.TeamAtMomentOpponent || playMeta.teamAtMomentOpponent || playMeta.AwayTeamName || playMeta.awayTeamName || null

          if (playCategory) update.play_category = playCategory
          if (playType) update.play_type = playType
          if (gameDate) update.game_date = gameDate
          if (homeTeam) update.home_team = homeTeam
          if (awayTeam) update.away_team = awayTeam
          if (circulationCount > 0) update.circulation_count = circulationCount

          if (Object.keys(update).length === 0) {
            return { id: e.id, ek: e.external_id, error: "no metadata to update (keys: " + Object.keys(playMeta).join(",") + ")" }
          }

          return { id: e.id, ek: e.external_id, update, error: null }
        } catch (err) {
          return { id: e.id, ek: e.external_id, error: err instanceof Error ? err.message : String(err) }
        }
      })
    )

    for (const r of results) {
      if (r.error) {
        failed++
        if (sampleErrors.length < 5) {
          sampleErrors.push(r.ek + ": " + r.error)
        }
        continue
      }
      const { error: upErr } = await (supabaseAdmin as any)
        .from("editions")
        .update(r.update)
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

  // Step 3: Backfill tier from wallet_moments_cache for editions missing tier
  let tierBackfilled = 0
  try {
    const tierSql = `
      UPDATE editions e
      SET tier = UPPER(wmc.tier)::edition_tier
      FROM (
        SELECT DISTINCT ON (edition_key) edition_key, tier
        FROM wallet_moments_cache
        WHERE tier IS NOT NULL AND tier != ''
      ) wmc
      WHERE e.external_id = wmc.edition_key
        AND e.tier IS NULL
    `
    const { data: tierResult, error: tierErr } = await (supabaseAdmin as any)
      .rpc("execute_sql", { query: tierSql })
    if (tierErr) {
      console.log("[backfill-edition-names] tier backfill error: " + tierErr.message)
    } else {
      tierBackfilled = Array.isArray(tierResult) ? tierResult.length : 0
      console.log("[backfill-edition-names] tier backfill from wallet_moments_cache: " + tierBackfilled + " editions updated")
    }
  } catch (err) {
    console.warn("[backfill-edition-names] tier backfill error:", err instanceof Error ? err.message : err)
  }

  // Step 4: Count remaining editions missing metadata
  const { count: remaining } = await (supabaseAdmin as any)
    .from("editions")
    .select("id", { count: "exact", head: true })
    .or("play_category.is.null,circulation_count.is.null,game_date.is.null")
    .filter("external_id", "match", "^\\d+:\\d+$")

  return NextResponse.json({
    ok: true,
    stubs_found: editionsToFill.length,
    updated,
    failed,
    tier_backfilled: tierBackfilled,
    remaining: remaining ?? 0,
    sample_errors: sampleErrors,
  })
}
