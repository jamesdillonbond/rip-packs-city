// lib/fast-break/page-data.ts
//
// The active-run and tonight's-slate reads behind /[collection]/fast-break.
//
// ⚠ NEITHER READ CHECKED ITS ERROR, and both render as an assertion:
//   • a failed `fast_break_runs` read left `run` undefined, and the page
//     renders that as "No active Fast Break run — We'll surface the next run
//     here as soon as Top Shot opens it", with the subtitle "No active run".
//     Shown DURING an active run, that tells a collector the game is not on
//     when it is, and the copy explicitly promises we would say otherwise.
//   • a failed `nba_games` read left the slate empty, so tonight's games
//     silently vanished from a page whose whole subject is tonight.
//
// Both lived in a `page.tsx`, which neither coverage gate measures.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

// ── BUDGETS ─────────────────────────────────────────────────────────────────
// ⚠ Both reads are awaited INLINE by the server page with no Suspense boundary,
// and a read that is merely SLOW errors nowhere — supabase-js resolves
// `{ data, error }` only when the query finishes. So the `ok: false` branches
// above, written for exactly this page's copy, were unreachable from the failure
// DB saturation actually produces: the page hangs on a streaming shell and
// Vercel logs a 200.
//
// ⚠ The page awaits these SEQUENTIALLY (run, then slate), so its ceiling is the
// SUM: 3 + 3 = 6s. Both are single-table indexed reads, which is why neither
// borrows a board's 8s.
const ACTIVE_RUN_TIMEOUT_MS = 3_000
const SLATE_TIMEOUT_MS = 3_000

export interface ActiveRun {
  id: string
  name: string
  lineup_size: number
  has_captain: boolean
  start_date: string | null
  end_date: string | null
}

export interface SlateGame {
  gameId: string
  homeTeam: string
  awayTeam: string
  tipoffAt: string | null
  status: string
}

/**
 * The currently-active Fast Break run.
 *
 * ⚠ Three states. A null run with `ok: true` means Top Shot is genuinely
 * between runs — the "no active run" card is correct and must keep rendering
 * for that case, since it is the page's normal off-season state.
 */
export async function fetchActiveRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<{ run: ActiveRun | null; ok: boolean }> {
  let data: unknown
  let error: { message: string } | null = null
  try {
    ;({ data, error } = await withBoardBudget<{
      data: unknown
      error: { message: string } | null
    }>(
      Promise.resolve(
        db
          .from("fast_break_runs")
          .select("id, name, lineup_size, has_captain, start_date, end_date")
          .eq("is_active", true)
          .maybeSingle(),
      ),
      "active-run",
      ACTIVE_RUN_TIMEOUT_MS,
      "fast-break/",
    ))
  } catch (e) {
    // ⚠ Same outcome as an error, deliberately. "No active Fast Break run" is a
    // claim about TOP SHOT'S SCHEDULE, and it must not be manufactured from a
    // read we could not finish any more than from one that failed.
    console.log("[fast-break] active run read bound:", e instanceof Error ? e.message : e)
    return { run: null, ok: false }
  }
  if (error) {
    console.log("[fast-break] active run read error:", error.message)
    return { run: null, ok: false }
  }
  return { run: (data as ActiveRun | null) ?? null, ok: true }
}

/**
 * Tonight's NBA slate.
 *
 * ⚠ `ok` matters even though the slate is decoration next to the run: an empty
 * slate is a real and common answer (the NBA does not play every night), so the
 * page must be able to say "we couldn't load tonight's games" rather than
 * implying there are none.
 */
export async function fetchSlate(
  gameDate: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<{ games: SlateGame[]; ok: boolean }> {
  let data: unknown
  let error: { message: string } | null = null
  try {
    ;({ data, error } = await withBoardBudget<{
      data: unknown
      error: { message: string } | null
    }>(
      Promise.resolve(
        db
          .from("nba_games")
          .select("id, home_team_abbr, away_team_abbr, tipoff_at, status")
          .eq("game_date", gameDate)
          .order("tipoff_at", { ascending: true }),
      ),
      "slate",
      SLATE_TIMEOUT_MS,
      "fast-break/",
    ))
  } catch (e) {
    console.log("[fast-break] slate read bound:", e instanceof Error ? e.message : e)
    return { games: [], ok: false }
  }
  if (error) {
    console.log("[fast-break] slate read error:", error.message)
    return { games: [], ok: false }
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>
  return {
    games: rows.map((g) => ({
      gameId: g.id as string,
      homeTeam: g.home_team_abbr as string,
      awayTeam: g.away_team_abbr as string,
      tipoffAt: (g.tipoff_at as string | null) ?? null,
      status: g.status as string,
    })),
    ok: true,
  }
}
