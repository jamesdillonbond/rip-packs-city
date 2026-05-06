// app/api/fast-break/lineup/route.ts
//
// Authenticated lineup save. Heavy lifting now happens inside the
// save_fast_break_lineup Postgres function — that gives us a single
// transaction across the lineup upsert + per-player use-counter delta,
// which is the only safe way to handle the swap path (decrement removed
// player's times_used, increment added player's, all-or-nothing). This
// route is the thin auth/validation/eligibility shim around the function.
//
// Three behaviors the function encodes:
//   first save        — insert lineup row, increment uses for every player
//   idempotent re-save — same set of player ids (order-independent), no
//                        use-counter movement; only the lineup row's
//                        captain/players jsonb is refreshed
//   swap               — decrement removed players, increment added players
//
// Pre-bug behavior: the JS path would re-increment all players on every
// save, double-burning the use budget on retry/double-click and leaving
// removed players' counters orphaned after a swap. Repro confirmed via
// DB simulation before this refactor.

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { computeLineupDiff } from "@/lib/fast-break-lineup-save"

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

  // Reject duplicate nbaPlayerIds in the same lineup body (Set vs array).
  if (new Set(playerIds).size !== playerIds.length) {
    return NextResponse.json(
      { error: "duplicate_players_in_body" },
      { status: 400, headers: ROUTE_HEADERS },
    )
  }

  try {
    // 1. Run lookup + range/size validation.
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

    if (captainNbaPlayerId && !playerIds.includes(captainNbaPlayerId)) {
      return NextResponse.json(
        { error: "captain_not_in_lineup" },
        { status: 400, headers: ROUTE_HEADERS },
      )
    }

    // 2. Eligibility lookup — required so the function can fall back to
    // the run's tier→total_allowed mapping when inserting a brand-new
    // fast_break_player_uses row for an added player.
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

    // 3. Observability: compute the diff client-side too so the response
    // can surface idempotent vs swap vs first_save without making a
    // second round trip. The Postgres function recomputes its own diff
    // under FOR UPDATE; this is purely advisory.
    const { data: existingLineup } = await supabase
      .from("fast_break_lineups")
      .select("players")
      .eq("user_id", user.id)
      .eq("run_id", runId)
      .eq("game_date", gameDate)
      .maybeSingle()
    const existingPlayerIds: string[] | null = existingLineup
      ? (Array.isArray(existingLineup.players)
          ? (existingLineup.players as any[])
              .map(p => (p && typeof p === "object" ? p.nbaPlayerId : null))
              .filter((x): x is string => typeof x === "string")
          : [])
      : null
    const diff = computeLineupDiff(existingPlayerIds, playerIds)

    // 4. Build the eligibility array the function expects (only for the
    // players in the lineup — saves payload size).
    const eligibilityForFn = players.map(p => {
      const e = eligibleByPlayer.get(p.nbaPlayerId)
      return {
        nba_player_id: p.nbaPlayerId,
        highest_tier: e?.highest_tier ?? "COMMON",
        total_allowed: Number(e?.total_allowed ?? 1),
      }
    })

    // 5. Atomic write — see save_fast_break_lineup migration for the
    // contract. Returns one of:
    //   { ok: true, idempotent, lineup_id, added, removed, use_counts }
    //   { error: 'exceeds_use_budget', player_id, times_used, total_allowed }
    const { data: result, error: rpcErr } = await (supabase as any).rpc(
      "save_fast_break_lineup",
      {
        p_user_id: user.id,
        p_wallet_addr: walletAddr,
        p_run_id: runId,
        p_game_date: gameDate,
        p_players: players,
        p_captain_nba_player_id: captainNbaPlayerId ?? null,
        p_eligibility: eligibilityForFn,
      },
    )
    if (rpcErr) {
      console.error("[fast-break-lineup] save_fast_break_lineup:", rpcErr.message)
      return NextResponse.json(
        { error: "lineup_write_failed", detail: rpcErr.message },
        { status: 500, headers: ROUTE_HEADERS },
      )
    }

    if (result?.error === "exceeds_use_budget") {
      return NextResponse.json(
        {
          error: "exceeds_use_budget",
          playerId: result.player_id,
          timesUsed: Number(result.times_used ?? 0),
          totalAllowed: Number(result.total_allowed ?? 0),
        },
        { status: 409, headers: ROUTE_HEADERS },
      )
    }

    const useCounts = (result?.use_counts ?? []).map((u: any) => ({
      nbaPlayerId: u.nba_player_id,
      timesUsed: Number(u.times_used ?? 0),
      totalAllowed: Number(u.total_allowed ?? 0),
    }))

    return NextResponse.json(
      {
        ok: true,
        idempotent: !!result?.idempotent,
        firstSave: diff.isFirstSave,
        lineupId: result?.lineup_id ?? null,
        added: result?.added ?? [],
        removed: result?.removed ?? [],
        useCounts,
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
