// Honest degradation for the public /insights boards.
//
// WHY THIS EXISTS. Every board page fetches its backing views with a fail-soft
// `if (error) return []` so one bad view can't blank the whole surface. That was the
// right instinct and the wrong output: under disk-IO saturation the backing query
// returns 57014 ("canceling statement due to statement timeout"), the page catches it,
// returns [], and the board renders as EMPTY — HTTP 200, no error state, a reader
// cannot tell "nothing matched" from "we failed to ask".
//
// Measured in production 2026-08-09: a single /insights/candy-mlb render logged SIX
// simultaneous timeouts (scarcity, parallel_premium, pack-ev, player_board, pack-market,
// special_serials) and still served 200. This is exactly the failure the roadmap
// amendment names — a timeout must not render as a number — and it is invisible to
// both the 5xx metrics (it is a 200) and the board-liveness probe (which measures
// `SELECT count(*)` on the view, a query the planner prunes, not the real page query).
//
// The PAGINATED case is sharper still. /insights/panini-squeeze pages 10x600 through a
// board ORDERED BY fmv_usd DESC; a failure on page 3 returns the first 1,800 rows and
// renders them as though they were the whole ranking. Truncating a ranked board silently
// is worse than blanking it, because every number on screen still looks right.
//
// This module is deliberately PURE (no Supabase import) so it is unit-testable and
// costs nothing at render. Pages wrap their fetches, collect the statuses, and hand
// the summary to the client, which renders <DegradedDataNotice>.

/** Outcome of one board's backing query. */
export interface BoardStatus {
  /** Human-facing section name, e.g. "Scarcity" — shown verbatim in the notice. */
  label: string
  /** false when the query errored. NOT the same as "returned no rows". */
  ok: boolean
  /**
   * true when the section is TRUNCATED rather than absent — some rows arrived
   * before a failure, OR the read filled a hard cap and there is more behind it.
   *
   * ⚠ Reported REGARDLESS of `ok`, and the doc here used to say the opposite
   * ("meaningless when `ok` is true"). That sentence licensed a real defect on
   * 2026-08-12: a page-capped read is `ok: true, partial: true` — "the query
   * succeeded and I know it was cut short" — and summarizeDegraded read `partial`
   * only inside its `!ok` branch, so the notice vanished while the caller emptied
   * its rows. A blank board with nothing explaining it. A caller that KNOWS its
   * read was truncated must never be able to say so and be ignored.
   */
  partial?: boolean
}

export interface DegradedSummary {
  /** Sections that returned nothing because their query failed. */
  failed: string[]
  /** Sections showing an incomplete slice because a later page failed. */
  truncated: string[]
  /** Total sections attempted — the denominator the notice reports. */
  total: number
  /** One sentence, already assembled, safe to render as-is. */
  headline: string
}

/**
 * Fold per-board outcomes into a render-ready summary.
 *
 * Returns `null` when everything loaded — the caller renders no notice at all, so a
 * healthy page is byte-identical to its pre-2026-08-09 output.
 *
 * A board that succeeded with zero rows is NOT degraded: an empty board is a real,
 * honest answer, and calling it a failure would be its own dishonesty.
 */
export function summarizeDegraded(statuses: BoardStatus[]): DegradedSummary | null {
  const failed: string[] = []
  const truncated: string[] = []

  for (const s of statuses) {
    // Truncation is checked FIRST and independently of `ok` — see BoardStatus.partial.
    // A successful-but-capped read is still an incomplete slice, and silently
    // dropping it is what produced a blank, unexplained board.
    if (s.partial) {
      truncated.push(s.label)
      continue
    }
    if (s.ok) continue
    failed.push(s.label)
  }

  if (failed.length === 0 && truncated.length === 0) return null

  const total = statuses.length
  const parts: string[] = []
  if (failed.length > 0) {
    // `total`, not `failed.length`, drives this plural: the sentence reads
    // "1 of 1 section", "2 of 10 sections". A single-board surface (panini-squeeze)
    // otherwise rendered "1 of 1 sections" live.
    parts.push(
      `${failed.length} of ${total} ${total === 1 ? "section" : "sections"} could not be loaded (${failed.join(", ")})`
    )
  }
  if (truncated.length > 0) {
    parts.push(
      `${truncated.length} ${truncated.length === 1 ? "section is" : "sections are"} showing an incomplete slice (${truncated.join(", ")})`
    )
  }

  // The second sentence is the load-bearing half: it tells the reader the blank is a
  // fetch failure, not a measurement. Without it an empty section still reads as data.
  const headline =
    `${parts.join("; ")}. This is a temporary database-load failure, not an empty result — ` +
    `treat the affected sections as unknown rather than zero, and reload shortly.`

  return { failed, truncated, total, headline }
}

/** Convenience for the common non-paginated case. */
export function boardStatus(label: string, ok: boolean): BoardStatus {
  return { label, ok }
}

/**
 * Degradation implied by the CACHE READ itself, for boards served through
 * readBoardOrLive().
 *
 * WHY THIS IS SEPARATE from the `degraded` roll-up a board builder puts in its
 * payload: on the `live-degraded` path there IS no payload. readBoardOrLive
 * returns `{}` when the live query failed AND no snapshot exists to fall back
 * on, so `payload.degraded` is `undefined` and the board renders EMPTY at
 * HTTP 200 — the same "failure renders as nothing matched" lie the rest of this
 * module exists to prevent, arriving by a different route. All five cached
 * boards discarded `source` and so could not see it.
 *
 * `stale-cache` is deliberately NOT degraded: it serves COMPLETE last-good data
 * carrying its own `fetchedAt`/`cache_stale` meta, which the clients already
 * surface as an age. Flagging it would cry wolf on the cache working as designed.
 */
export function degradedFromSource(source: string, label: string): DegradedSummary | null {
  return source === "live-degraded" ? summarizeDegraded([boardStatus(label, false)]) : null
}
