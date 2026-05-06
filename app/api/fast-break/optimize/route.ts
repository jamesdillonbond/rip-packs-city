// app/api/fast-break/optimize/route.ts
//
// Builds the recommended Fast Break lineup for a wallet+run pair. The wallet
// itself is the implicit auth boundary (anyone querying a wallet sees its
// public ownership), so this is unauthenticated. Heavy lifting is in
// lib/fast-break-optimizer.ts (pure-function); this route does the I/O.

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import {
  buildOptimalLineup,
  findAcquisitionGap,
  type EligiblePlayer,
  type ProjectedPlayer,
  type Tier,
} from "@/lib/fast-break-optimizer"

export const dynamic = "force-dynamic"

const ROUTE_HEADERS: Record<string, string> = { "X-RPC-Route": "fast-break-optimize" }
const NBA_TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const bodySchema = z.object({
  walletAddr: z.string().regex(/^0x[a-f0-9]{16}$/i, "walletAddr must be a 0x + 16 hex Flow address"),
  runId: z.string().uuid(),
  lineupSize: z.union([z.literal(2), z.literal(3)]).optional(),
})

function todayInET(): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function eligibleFromRpcRow(e: any): EligiblePlayer {
  return {
    nbaPlayerId: e.nba_player_id,
    fullName: e.full_name,
    teamAbbr: e.current_team_abbr ?? "",
    highestTier: (e.highest_tier as Tier) ?? "COMMON",
    remainingUses: Number(e.remaining_uses ?? 0),
    bestMomentId: e.best_moment_id ?? "",
    bestSerial: Number(e.best_serial ?? 0),
  }
}

export async function POST(req: NextRequest) {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "malformed_json" }, { status: 400, headers: ROUTE_HEADERS })
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.format() },
      { status: 400, headers: ROUTE_HEADERS },
    )
  }
  const { runId } = parsed.data
  const walletAddr = parsed.data.walletAddr.toLowerCase()

  try {
    const { data: run, error: runErr } = await supabase
      .from("fast_break_runs")
      .select("id, lineup_size, has_captain, start_date, end_date")
      .eq("id", runId)
      .single()
    if (runErr || !run) {
      return NextResponse.json(
        { error: "run_not_found", detail: runErr?.message },
        { status: 404, headers: ROUTE_HEADERS },
      )
    }

    const lineupSize = (parsed.data.lineupSize ?? run.lineup_size) as 2 | 3

    const { data: eligibleRaw, error: eligErr } = await (supabase as any).rpc(
      "get_fb_eligible_players",
      { p_wallet_addr: walletAddr, p_run_id: runId },
    )
    if (eligErr) {
      console.error("[fast-break-optimize] get_fb_eligible_players:", eligErr.message)
      return NextResponse.json(
        { error: "eligible_rpc_failed", detail: eligErr.message },
        { status: 500, headers: ROUTE_HEADERS },
      )
    }
    const eligibleArr = (eligibleRaw ?? []) as any[]
    const eligible: EligiblePlayer[] = eligibleArr.map(eligibleFromRpcRow)

    const gameDate = todayInET()

    const { data: games } = await supabase
      .from("nba_games")
      .select("id, home_team_abbr, away_team_abbr, tipoff_at")
      .eq("game_date", gameDate)
    const gameIds = (games ?? []).map(g => g.id)
    const gameLookup = new Map((games ?? []).map(g => [g.id, g]))

    let projRows: any[] = []
    if (gameIds.length > 0) {
      const { data, error: projErr } = await supabase
        .from("nba_player_projections")
        .select("nba_player_id, game_id, proj_fp_dk, proj_minutes, injury_status")
        .in("game_id", gameIds)
        .eq("game_date", gameDate)
        .eq("source", "draftkings")
      if (projErr) {
        console.error("[fast-break-optimize] projections:", projErr.message)
        return NextResponse.json(
          { error: "projections_lookup_failed", detail: projErr.message },
          { status: 500, headers: ROUTE_HEADERS },
        )
      }
      projRows = data ?? []
    }
    const projByPlayer = new Map<string, any>(projRows.map(r => [r.nba_player_id, r]))

    // Inner-join eligibility × projections. Skip rows missing a projection
    // (player owns moments but team isn't playing tonight) and rows without
    // a usable proj_fp_dk (DK occasionally lists pool entries with null FP).
    const projected: ProjectedPlayer[] = []
    for (const e of eligible) {
      const proj = projByPlayer.get(e.nbaPlayerId)
      if (!proj || proj.proj_fp_dk == null) continue
      const game = gameLookup.get(proj.game_id)
      let opponent = ""
      if (game && e.teamAbbr) {
        if (game.home_team_abbr === e.teamAbbr) opponent = game.away_team_abbr
        else if (game.away_team_abbr === e.teamAbbr) opponent = game.home_team_abbr
      }
      projected.push({
        ...e,
        projPoints: Number(proj.proj_fp_dk),
        // DraftKings doesn't expose minutes; fallback to 32 keeps the
        // suggestCaptainAlternates variance heuristic stable.
        projMinutes: proj.proj_minutes != null ? Number(proj.proj_minutes) : 32,
        injuryStatus: proj.injury_status ?? null,
        gameId: proj.game_id,
        opponentTeamAbbr: opponent,
      })
    }

    const lineup = buildOptimalLineup(projected, lineupSize, !!run.has_captain)

    // Top-3 alternates: re-run the optimizer on a pool that excludes each
    // chosen lineup so the user sees the next-best swap-out options.
    const alternates: ReturnType<typeof buildOptimalLineup>[] = []
    if (lineup) {
      let pool = projected.filter(p => !lineup.players.find(x => x.nbaPlayerId === p.nbaPlayerId))
      for (let i = 0; i < 3; i++) {
        if (pool.length < lineupSize) break
        const alt = buildOptimalLineup(pool, lineupSize, !!run.has_captain)
        if (!alt) break
        alternates.push(alt)
        pool = pool.filter(p => !alt.players.find(x => x.nbaPlayerId === p.nbaPlayerId))
      }
    }

    // Acquisition gap: who would the optimal lineup be if ownership were
    // unconstrained? The "wanted" set is the top-N ranked projections across
    // tonight's slate (any player, OUT excluded). Anything in that set the
    // user can't slot becomes a "missing" recommendation.
    const allRanked = projRows
      .filter(r => r.proj_fp_dk != null && (r.injury_status ?? "ACTIVE") !== "OUT")
      .sort((a, b) => Number(b.proj_fp_dk) - Number(a.proj_fp_dk))
      .slice(0, lineupSize)
    const wantedIds = allRanked.map(r => r.nba_player_id as string)
    const missingIds = findAcquisitionGap(wantedIds, eligible)

    const missingPlayers: any[] = []
    if (missingIds.length > 0) {
      const { data: missingMeta } = await supabase
        .from("nba_players")
        .select("id, full_name, current_team_abbr")
        .in("id", missingIds)
      const metaMap = new Map((missingMeta ?? []).map(m => [m.id, m]))

      for (const id of missingIds) {
        const ranked = allRanked.find(r => r.nba_player_id === id)
        const meta = metaMap.get(id)
        const fullName = meta?.full_name ?? null
        let cheapest: { momentId: string | null; askUsd: number; url: string | null } | null = null
        if (fullName) {
          const { data: listingRows } = await supabase
            .from("cached_listings")
            .select("moment_id, ask_price, buy_url")
            .eq("collection_id", NBA_TOP_SHOT_UUID)
            .eq("player_name", fullName)
            .order("ask_price", { ascending: true })
            .limit(1)
          const listing = (listingRows ?? [])[0]
          if (listing && listing.ask_price != null) {
            cheapest = {
              momentId: listing.moment_id,
              askUsd: Number(listing.ask_price),
              url: listing.buy_url ?? null,
            }
          }
        }
        missingPlayers.push({
          nbaPlayerId: id,
          fullName,
          teamAbbr: meta?.current_team_abbr ?? null,
          projFp: ranked?.proj_fp_dk != null ? Number(ranked.proj_fp_dk) : null,
          cheapestListing: cheapest,
        })
      }
    }

    return NextResponse.json(
      {
        walletAddr,
        runId,
        gameDate,
        lineupSize,
        eligibleCount: eligible.length,
        consideredCount: projected.length,
        lineup,
        alternates,
        missingPlayers,
      },
      { headers: ROUTE_HEADERS },
    )
  } catch (err: any) {
    console.error("[fast-break-optimize]", err?.message ?? err)
    return NextResponse.json(
      { error: "internal_error", detail: err?.message ?? String(err) },
      { status: 500, headers: ROUTE_HEADERS },
    )
  }
}
