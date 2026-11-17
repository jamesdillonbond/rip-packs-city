// _shared/match-run-summary.ts
//
// Canonical, unit-tested pure primitive for match-topshot-players' runWork — the
// mapping from the match_topshot_players_run() RPC summary into the pipeline_runs
// counters. That row is the ONLY visibility into a fire-and-forget edge fn (it
// returns 202 "queued" immediately), so a miscounted field silently misreports
// how many aliases were written vs left for manual review.
//
// The edge fn keeps this inline (not redeployed to import); __tests__/
// edge-pack-supply-parse.test.ts pins the edge source to still contain the
// load-bearing expressions. Change them together.

export interface MatchRunSummaryInput {
  skipped?: unknown
  auto_aliased?: unknown
  total_unresolved?: unknown
  needs_review?: unknown
}

export interface MatchRunCounters {
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  needsReview: unknown[]
  needsReviewCount: number
  needsManualReview: unknown[]
}

/**
 * Derive the pipeline_runs counters from the RPC summary. Invariants:
 *   - rows_found = skipped + total_unresolved (the work considered), NOT the
 *     aliases written;
 *   - rows_written = auto_aliased (only high-confidence auto-matches);
 *   - needs_review is coerced to an array and CAPPED at 200 for the extra blob so
 *     a huge unresolved list can't bloat pipeline_runs, while its full length is
 *     still reported as needs_review_count.
 */
export function summarizeMatchRun(data: MatchRunSummaryInput | null | undefined): MatchRunCounters {
  const summary = (data ?? {}) as MatchRunSummaryInput
  const skipped = Number(summary.skipped ?? 0)
  const autoAliased = Number(summary.auto_aliased ?? 0)
  const totalUnresolved = Number(summary.total_unresolved ?? 0)
  const needsReview = Array.isArray(summary.needs_review) ? summary.needs_review : []
  return {
    rowsFound: skipped + totalUnresolved,
    rowsWritten: autoAliased,
    rowsSkipped: skipped,
    needsReview,
    needsReviewCount: needsReview.length,
    needsManualReview: needsReview.slice(0, 200),
  }
}
