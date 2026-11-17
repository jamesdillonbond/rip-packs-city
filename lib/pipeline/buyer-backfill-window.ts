// lib/pipeline/buyer-backfill-window.ts
//
// The forward window and run verdict for /api/admin/backfill-allday-buyers
// (All Day + Golazos buyer/seller re-resolve from tx events).
//
// WHY THE FLOOR IS THE SPORK, NOT A YEAR (2026-10-17). The route decodes each
// sale's transaction through current-spork REST (rest-mainnet.onflow.org),
// which only knows transactions from mainnet27's root on (height 130,290,658,
// 2025-10-22). The window used to start 2025-01-01 on the belief that "2025+"
// was current-spork. It is not: from 10-15 the cursor crossed below 10-22 and
// every run failed to decode 480 of 480 rows, wrote 0, and still logged
// ok=true, walking ~10 months of rows that can never resolve (known-issues
// #192). The historical access nodes that could decode them (mainnet24-26)
// went dark 10-08/09 (#181).
//
// ⚠ 2026-10-23 ~2:20 AM PT: THE FLOOR IS THE NODE'S ROOT BLOCK, NOT A DATE. The
// 2:15 AM run (the first to reach the window floor after the custodial fix)
// found 41 rows it could never decode: `allday_studio_history_v1` sales dated
// 2025-10-22 00:19–09:24 UTC — BEFORE mainnet27's sporkTime (13:00 UTC, per
// onflow/flow sporks.json), i.e. mainnet26 transactions, which no live node
// serves. A midnight floor admitted them, so every cursor wrap ended on a
// "decode wall: all 41 non-custodial rows failed" — one red run per cycle, the
// exact shape the 10-17 floor was meant to end. And rest-mainnet.onflow.org is
// not mainnet27 any more: measured tonight, it serves blocks from 137,390,146
// (mainnet28's root, sealed 2025-12-29T03:11:27Z; 137,390,131 → 404). The floor
// is that root block's timestamp. Between mainnet27's and mainnet28's roots
// 0 unresolved rows remain (measured), so nothing is newly excluded.
export const CURRENT_SPORK_START_ISO = "2025-12-29T03:11:27Z"

export type BuyerBackfillCounts = {
  found: number
  decodeFailed: number
  updateFailed: number
  /**
   * Rows whose tx DECODED and named the Dapper custodian as the deposit target (2026-10-22): the
   * buyer is not knowable from that tx, by a recorded decision — not a decode failure. Optional
   * for callers that predate it (absent = 0).
   */
  custodial?: number
}

// A run is NOT ok when it wrote nothing it read: every row in a non-empty
// batch failed to decode (a decode wall — the shape #192 hid behind ok=true),
// or any resolved row's UPDATE failed (a swallowed write). Rows that decode to
// no buyer one at a time are normal and stay counted in decode_failed.
//
// ⚠ 2026-10-22: a CUSTODIAL row is not a failure. ~1,295 All Day sales (mostly 2026-05-18 → 06-29)
// deposit to the Dapper custodian 0xddfbe848a81b2236, which the decoder rightly refuses as a buyer.
// Counted as decode_failed, every batch that fell in that band was a "decode wall" — 5 of 16 runs
// red over three days, re-walked on every wrap (inbox 2026-10-23T0310Z). The wall is now measured
// over the rows that COULD have yielded a buyer.
export function buyerBackfillVerdict(c: BuyerBackfillCounts): { ok: boolean; error: string | null } {
  if (c.updateFailed > 0) {
    return { ok: false, error: `${c.updateFailed} sales update(s) failed` }
  }
  const decodable = c.found - (c.custodial ?? 0)
  if (decodable > 0 && c.decodeFailed >= decodable) {
    return { ok: false, error: `decode wall: all ${decodable} non-custodial rows failed to decode` }
  }
  return { ok: true, error: null }
}

// ── The walk's cursor: (sold_at, id), never sold_at alone ───────────────────
//
// ⚠ 2026-10-23 ~6:30 AM PT: the walk paged `sold_at < cursor` on a NON-unique
// key. Nine unresolved All Day rows share one `sold_at` (2026-06-11 14:55:09.664)
// with the row the 8:15 PM run's batch ended on; `lt` skipped them, and they
// stayed skipped until a later cycle's batch boundaries happened to fall
// elsewhere. CLAUDE.md's rule — "cursor paging needs a UNIQUE tiebreak" — made
// concrete: the cursor is the smallest (sold_at, id) the run processed, and the
// next run resumes STRICTLY below it in that order, so a timestamp shared across
// a batch boundary loses no row. `id` is a uuid; Postgres orders uuids bytewise,
// which is the lexical order of their lowercase hex text, so a string compare
// here agrees with `ORDER BY id DESC` there.
export interface SaleCursorRow {
  sold_at: string
  id: string
}

/** True when `a` sorts strictly below `b` in (sold_at DESC, id DESC) walk order. */
export function cursorRowBelow(a: SaleCursorRow, b: SaleCursorRow): boolean {
  if (a.sold_at !== b.sold_at) return a.sold_at < b.sold_at
  return a.id < b.id
}

/**
 * The PostgREST `or=` filter that continues the walk strictly below a cursor.
 * Without an id (a run logged before 2026-10-23) it is the old `sold_at <` and
 * the next run writes the full cursor.
 */
export function cursorOrFilter(c: { soldAt: string; id: string | null }): string {
  return c.id
    ? `sold_at.lt.${c.soldAt},and(sold_at.eq.${c.soldAt},id.lt.${c.id})`
    : `sold_at.lt.${c.soldAt}`
}
