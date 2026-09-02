/**
 * Per-request accumulator for sniper-feed source read failures.
 *
 * The sniper feed assembles a board from several independent reads — the
 * `ts_listings` pool, the All Day marketplace GQL, two deal RPCs, an FMV map.
 * Every one of them collapsed to an empty list on failure, so the route
 * answered 200 with `deals: []` and the client printed
 *
 *     "No deals match your filters. Try widening your search."
 *
 * — a CONCLUSION drawn from a read that never happened, and the actionable
 * sub-class of it: it sends the reader to widen filters that were never the
 * reason the board is empty. Live evidence, 2026-09-02: four users hit
 * `[sniper-feed] AD GQL FAILED: HTTP 403` in 24h while the board rendered quiet.
 *
 * There are three states, not two: the read failed · the read succeeded and the
 * floor is genuinely quiet · the read succeeded and the rows were unusable
 * (no FMV, filtered out). Only the first one belongs here.
 *
 * ⚠ A sink is created PER COMPUTE CALL and threaded as an argument. A
 * module-level sink would leak one request's failures into another's response,
 * and this route is cached per-param inside a warm lambda.
 *
 * ⚠ Only reads that can SUPPRESS DEALS are noted. Enrichment reads (badges,
 * jersey numbers, pack EV) degrade a row's decoration, not its existence, so
 * noting them would make the empty-state copy fire on a board that is honestly
 * empty.
 */

export interface SourceFailureSink {
  /** Failed source labels, first-seen order, deduped. Internal names — not UI copy. */
  readonly failed: string[];
  note(source: string): void;
}

export function createSourceFailureSink(): SourceFailureSink {
  const failed: string[] = [];
  return {
    failed,
    note(source: string) {
      if (!source) return;
      if (!failed.includes(source)) failed.push(source);
    },
  };
}

/** True when at least one deal-bearing read failed on this request. */
export function sniperFeedDegraded(sourcesFailed: readonly string[] | null | undefined): boolean {
  return Array.isArray(sourcesFailed) && sourcesFailed.length > 0;
}

/**
 * Empty-state copy. REPORTS the failed read; never concludes about supply, and
 * never tells the reader to change a filter — the filters are not why the list
 * is empty. Source labels stay out of the copy; they ride the response for
 * debugging instead.
 */
export const SNIPER_DEGRADED_EMPTY_COPY =
  "Couldn't reach the listing feed just now, so this list is incomplete — it says nothing about how many deals are out there. Try again in a moment.";

export const SNIPER_DEGRADED_EMPTY_HEADING = "COULDN'T LOAD THE FLOOR";

/**
 * Picks the empty-state copy for a feed response. `fallback` is the genuine
 * "we looked and found nothing" line, and is only returned when we actually
 * looked.
 */
export function sniperEmptyCopy(
  sourcesFailed: readonly string[] | null | undefined,
  fallback: string
): string {
  return sniperFeedDegraded(sourcesFailed) ? SNIPER_DEGRADED_EMPTY_COPY : fallback;
}
