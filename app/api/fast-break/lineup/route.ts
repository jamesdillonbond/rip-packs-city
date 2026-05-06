// app/api/fast-break/lineup/route.ts
//
// Authenticated lineup save. Writes fast_break_lineups (one row per
// user+run+game_date) and incrementally updates fast_break_player_uses for
// each player that hasn't yet been used on this game_date in this run.
//
// Concurrency note: Supabase doesn't expose multi-statement transactions to
// the JS client, so this uses precheck-then-write. With the unique constraints
// on both tables and the per-player budget check pre-flight, the worst-case
// race is two near-simultaneous saves that each pass precheck and then both
// write — the second write will land but exceed the budget by one. Acceptable
// for v1; revisit with an RPC-encapsulated transaction if abuse appears.

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

const ROUTE_HEADERS: Record<string, string> = { "X-RPC-Route": "fast-break-lineup" }

const playerSchema = z.object({
  nbaPlayerId: z.string().uuid(),
  momentId: z.string().min(1),
  serial: z.coerce.number().int().min(1),
})

const bodySchema = z.object({
  walletAddr: z.string().regex(/^0x[a-f0-9]{16}$/i, "walletAddr must be a 0x + 16 hex Flow address"),
  runId: z.string().uuid(),
  gameDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "gameDate must be YYYY-MM-DD"),
  players: z.array(playerSchema).min(1).max(5),
  captainNbaPlayerId: z.string().uuid().optional(),
})

export async function POST(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

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

  const { runId, gameDate, players, captainNbaPlayerId } = parsed.data
  const walletAddr = parsed.data.walletAddr.toLowerCase()
  const playerIds = players.map(p => p.nbaPlayerId)

  try {
    // 1. Run lookup + date/size validation.
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

    if (gameDate < run.start_date || gameDate > run.end_date) {
      return NextResponse.json(
        { error: "game_date_outside_run", detail: { gameDate, runStart: run.start_date, runEnd: run.end_date } },
        { status: 400, headers: ROUTE_HEADERS },
      )
    }
    if (players.length !== run.lineup_size) {
      return NextResponse.json(
        { error: "lineup_size_mismatch", detail: { sent: players.length, expected: run.lineup_size } },
        { status: 400, headers: ROUTE_HEADERS },
      )
    }

    // Captain must be one of the lineup players when set.
    if (captainNbaPlayerId && !playerIds.includes(captainNbaPlayerId)) {
      return NextResponse.json(
        { error: "captain_not_in_lineup" },
        { status: 400, headers: ROUTE_HEADERS },
      )
    }

    // 2. Eligibility metadata — needed for first-time INSERTs into
    // fast_break_player_uses (highest_tier_owned + total_allowed columns).
    const { data: eligibleRaw, error: eligErr } = await (supabase as any).rpc(
      "get_fb_eligible_players",
      { p_wallet_addr: walletAddr, p_run_id: runId },
    )
    if (eligErr) {
      console.error("[fast-break-lineup] get_fb_eligible_players:", eligErr.message)
      return NextResponse.json(
        { error: "eligible_rpc_failed", detail: eligErr.message },
        { status: 500, headers: ROUTE_HEADERS },
      )
    }
    const eligibleByPlayer = new Map<string, any>(
      (eligibleRaw ?? []).map((e: any) => [e.nba_player_id, e]),
    )

    for (const p of players) {
      if (!eligibleByPlayer.has(p.nbaPlayerId)) {
        return NextResponse.json(
          { error: "player_not_eligible", playerId: p.nbaPlayerId },
          { status: 400, headers: ROUTE_HEADERS },
        )
      }
    }

    // 3. Read existing lineup row for this date — needed to detect re-saves
    // and skip use-counter increments for players who were already part of
    // the lineup on this exact date.
    const { data: existingLineup } = await supabase
      .from("fast_break_lineups")
      .select("players")
      .eq("user_id", user.id)
      .eq("run_id", runId)
      .eq("game_date", gameDate)
      .maybeSingle()
    const existingDatePlayerIds = new Set<string>(
      Array.isArray(existingLineup?.players)
        ? (existingLineup!.players as any[])
            .map(p => (p && typeof p === "object" ? p.nbaPlayerId : null))
            .filter(Boolean)
        : [],
    )

    // 4. Read existing per-player uses for the run.
    const { data: existingUses } = await supabase
      .from("fast_break_player_uses")
      .select("nba_player_id, times_used, total_allowed, dates_used, best_moment_id, best_serial")
      .eq("user_id", user.id)
      .eq("run_id", runId)
      .in("nba_player_id", playerIds)
    const usesByPlayer = new Map<string, any>(
      (existingUses ?? []).map(u => [u.nba_player_id, u]),
    )

    // 5. Precheck use-budget for each player who would get an increment.
    for (const p of players) {
      if (existingDatePlayerIds.has(p.nbaPlayerId)) continue // re-save, no increment
      const elig = eligibleByPlayer.get(p.nbaPlayerId)
      const existing = usesByPlayer.get(p.nbaPlayerId)
      const totalAllowed = Number(existing?.total_allowed ?? elig?.total_allowed ?? 0)
      const currentUses = Number(existing?.times_used ?? 0)
      if (currentUses + 1 > totalAllowed) {
        return NextResponse.json(
          {
            error: "exceeds_use_budget",
            playerId: p.nbaPlayerId,
            timesUsed: currentUses,
            totalAllowed,
          },
          { status: 409, headers: ROUTE_HEADERS },
        )
      }
    }

    // 6. Upsert the lineup row.
    const { error: lineupErr, data: lineupRow } = await supabase
      .from("fast_break_lineups")
      .upsert(
        {
          user_id: user.id,
          wallet_addr: walletAddr,
          run_id: runId,
          game_date: gameDate,
          players,
          captain_nba_player_id: captainNbaPlayerId ?? null,
          status: "planned",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,run_id,game_date" },
      )
      .select("id")
      .single()
    if (lineupErr) {
      console.error("[fast-break-lineup] lineup upsert:", lineupErr.message)
      return NextResponse.json(
        { error: "lineup_write_failed", detail: lineupErr.message },
        { status: 500, headers: ROUTE_HEADERS },
      )
    }

    // 7. For each player needing a bump, INSERT-or-UPDATE the use row.
    for (const p of players) {
      if (existingDatePlayerIds.has(p.nbaPlayerId)) continue // already counted
      const existing = usesByPlayer.get(p.nbaPlayerId)
      const elig = eligibleByPlayer.get(p.nbaPlayerId)!

      if (existing) {
        const { error } = await supabase
          .from("fast_break_player_uses")
          .update({
            times_used: Number(existing.times_used) + 1,
            dates_used: [...(existing.dates_used ?? []), gameDate],
            best_moment_id: existing.best_moment_id ?? p.momentId,
            best_serial: existing.best_serial ?? p.serial,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user.id)
          .eq("run_id", runId)
          .eq("nba_player_id", p.nbaPlayerId)
        if (error) {
          console.error("[fast-break-lineup] use update:", error.message, p.nbaPlayerId)
          // Continue — partial state is better than rolling back the lineup
          // we just wrote. Surfaced via the useCounts response so callers can
          // detect drift.
        }
      } else {
        const { error } = await supabase
          .from("fast_break_player_uses")
          .insert({
            user_id: user.id,
            run_id: runId,
            nba_player_id: p.nbaPlayerId,
            highest_tier_owned: elig.highest_tier,
            total_allowed: elig.total_allowed,
            times_used: 1,
            dates_used: [gameDate],
            best_moment_id: p.momentId,
            best_serial: p.serial,
          })
        if (error) {
          console.error("[fast-break-lineup] use insert:", error.message, p.nbaPlayerId)
        }
      }
    }

    // 8. Read fresh use counts for the response.
    const { data: latestUses } = await supabase
      .from("fast_break_player_uses")
      .select("nba_player_id, times_used, total_allowed")
      .eq("user_id", user.id)
      .eq("run_id", runId)
      .in("nba_player_id", playerIds)

    return NextResponse.json(
      {
        ok: true,
        lineupId: lineupRow?.id ?? null,
        useCounts: (latestUses ?? []).map(u => ({
          nbaPlayerId: u.nba_player_id,
          timesUsed: Number(u.times_used),
          totalAllowed: Number(u.total_allowed),
        })),
      },
      { headers: ROUTE_HEADERS },
    )
  } catch (err: any) {
    console.error("[fast-break-lineup]", err?.message ?? err)
    return NextResponse.json(
      { error: "internal_error", detail: err?.message ?? String(err) },
      { status: 500, headers: ROUTE_HEADERS },
    )
  }
}
