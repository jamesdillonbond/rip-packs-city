// lib/unmapped-rotating-window.ts
//
// Shared candidate loader for the two AllDay unmapped-sales resolvers
// (`allday-resolve-unmapped` and its >7d-tail sibling). Both walk the same
// ROTATING window — never-attempted rows first, then longest-since-attempted —
// and both used to express it as a single PostgREST `.or()`:
//
//   .or(`last_onchain_attempt_at.is.null,last_onchain_attempt_at.lt.${cutoff}`)
//   .order("last_onchain_attempt_at", { ascending: true, nullsFirst: true })
//   .limit(CANDIDATE_LIMIT)
//
// WHY THAT FORM TIMED OUT (measured 2026-08-04, AllDay >7d tail):
//
// The obvious diagnosis — "an OR is non-sargable" — is not the mechanism here.
// The supporting index already matches this query exactly, both the partial
// predicate and the sort:
//
//   idx_unmapped_sales_tail_resolver_targets
//     (collection_id, last_onchain_attempt_at NULLS FIRST, sold_at DESC)
//     WHERE resolved_at IS NULL AND price_usd > 0
//
// The real mechanism is that the SECOND ARM MATCHES NOTHING, and the planner
// cannot know that in advance. Live numbers for the tail's candidate set:
//
//   never_attempted (arm A)   36        <- far under CANDIDATE_LIMIT = 600
//   attempted       (arm B)   32,850
//   oldest attempt            2026-07-27
//   reattempt cutoff (-14d)   2026-07-21   <- OLDER than the oldest attempt
//
// Because the oldest stamp is NEWER than the reattempt cutoff, `< cutoff` is
// empty by construction. So the single-query form: returns its 36 NULL rows
// from the front of the index instantly, finds itself 564 rows short of the
// LIMIT, and therefore keeps walking — through ALL 32,850 remaining index
// entries, applying an OR filter that can never match again, to return nothing.
// A guaranteed full scan of the partial index on every tick, ending in
// `canceling statement due to statement timeout`.
//
// It is also SELF-PERPETUATING: each successful run stamps
// last_onchain_attempt_at on the rows it probes, which keeps arm A tiny, which
// guarantees the next run scans the full tail again.
//
// THE FIX: run the two arms as separate bounded queries and concatenate.
//   Arm A — `IS NULL`  -> the contiguous NULL group at the front of the index.
//   Arm B — `< cutoff` -> a range scan that STOPS at the first entry >= cutoff
//                         (immediately, while the horizon stays unreached).
// Neither arm can degenerate into a full scan, and arm B costs ~nothing exactly
// when it matches nothing — the case that was previously the most expensive.
//
// ORDERING IS PRESERVED EXACTLY. The original sort is
// `last_onchain_attempt_at ASC NULLS FIRST, sold_at DESC`, so every NULL row
// sorts ahead of every non-NULL row. Arm A (ordered sold_at DESC) is therefore
// precisely the head of that ordering, and arm B (ordered attempt ASC, then
// sold_at DESC) is precisely its continuation. Taking arm A first and topping up
// from arm B yields the identical row sequence the single query would have.

export type RotatingWindowArgs = {
  /** collections.id for the collection being resolved. */
  collectionId: string
  /** Comma-separated PostgREST select list. */
  columns: string
  /** Max rows across BOTH arms combined (the old `.limit(CANDIDATE_LIMIT)`). */
  limit: number
  /** ISO timestamp; rows attempted before this are eligible again. */
  reattemptCutoff: string
  /**
   * Optional ISO timestamp restricting to rows sold BEFORE it — the >7d tail
   * resolver sets this; the live resolver does not.
   */
  soldBefore?: string | null
}

export type RotatingWindowResult<T = any> = {
  data: T[] | null
  error: any
  /** Per-arm row counts, for pipeline_runs telemetry. */
  armCounts: { never_attempted: number; reattempt: number }
}

/**
 * Load the rotating candidate window as two bounded index range scans.
 * Returns a supabase-shaped `{ data, error }` so callers keep their existing
 * error handling, plus per-arm counts for telemetry.
 */
export async function loadRotatingWindow<T = any>(
  client: any,
  args: RotatingWindowArgs,
): Promise<RotatingWindowResult<T>> {
  const empty = { never_attempted: 0, reattempt: 0 }

  // A non-positive limit must not be turned into an unbounded read.
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    return { data: [], error: null, armCounts: empty }
  }

  const base = () => {
    let q = client
      .from("unmapped_sales")
      .select(args.columns)
      .eq("collection_id", args.collectionId)
      .is("resolved_at", null)
      .gt("price_usd", 0)
    if (args.soldBefore) q = q.lt("sold_at", args.soldBefore)
    return q
  }

  // ── Arm A: never attempted. The contiguous NULL group at the index head. ──
  const a = await base()
    .is("last_onchain_attempt_at", null)
    .order("sold_at", { ascending: false })
    .limit(args.limit)
  if (a.error) return { data: null, error: a.error, armCounts: empty }

  const rowsA: T[] = (a.data ?? []) as T[]
  if (rowsA.length >= args.limit) {
    return {
      data: rowsA.slice(0, args.limit),
      error: null,
      armCounts: { never_attempted: rowsA.length, reattempt: 0 },
    }
  }

  // ── Arm B: attempted, but longer ago than the reattempt horizon. ──────────
  // `.lt()` excludes NULLs on its own (NULL < x is NULL, never true), so the
  // two arms are disjoint and no row can appear twice.
  const b = await base()
    .lt("last_onchain_attempt_at", args.reattemptCutoff)
    .order("last_onchain_attempt_at", { ascending: true })
    .order("sold_at", { ascending: false })
    .limit(args.limit - rowsA.length)
  if (b.error) return { data: null, error: b.error, armCounts: empty }

  const rowsB: T[] = (b.data ?? []) as T[]
  return {
    data: [...rowsA, ...rowsB],
    error: null,
    armCounts: { never_attempted: rowsA.length, reattempt: rowsB.length },
  }
}
