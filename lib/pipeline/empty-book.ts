// lib/pipeline/empty-book.ts
//
// 2026-10-15: the Flowty listing-cache lanes (topshot / allday / golazos) treated
// an upstream answer of `200` with an EMPTY list as "end of book", so a sweep that
// read nothing at all logged `ok: true, rows_written: 0` — "the market has no
// listings" out of what is, at ~7k listings a day per lane, an upstream that has
// stopped answering. Flowty said on 2026-09-25 it will turn these endpoints off
// "soon" (roadmap-status.md); an off switch that answers 200 [] would have read as
// a quiet market until the multi-day zero-yield detector caught up, while the
// previous run's rows stayed in `cached_listings` (no purge runs without an upsert).
//
// A whole sweep that fetched ZERO items is reported as a failed run. A genuinely
// empty market on these collections is not a state they have ever been in; if one
// ever is, the alarm is the cheap mistake and the silent "0 listings" the costly one.

/** True when the sweep read not a single item from upstream. */
export function isEmptyBook(totalFetched: number): boolean {
  return totalFetched === 0
}

export const EMPTY_BOOK_ERROR =
  "upstream returned an empty book: 0 listings across the whole sweep — treated as an upstream outage, not an empty market; cached rows were not purged"
