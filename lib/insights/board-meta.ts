// lib/insights/board-meta.ts
//
// Honest row-count metadata for the public /api/public/insights/** boards.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Every one of those routes published `meta.total_rows: data?.length ?? 0`.
// That value is the length of the CAPPED PAGE, not a total — each route clamps
// `limit` (`Math.min(200, ...)`, `Math.min(500, ...)`, …) — so on any board
// bigger than its cap the field reports the cap and calls it a total.
//
// It is the NAME that made this dangerous rather than the arithmetic. A consumer
// reading `total_rows` has no reason to suspect a page length, and two OG social
// cards duly published it as a measurement. Measured 2026-08-15:
//
//   • /insights/squeeze  card: "200 editions squeezed 50%+" — true count 1,352
//   • /insights/trophies card: "500 grails ranked"          — true count   842
//
// Both are public link-preview images, so the understatement is what reaches a
// timeline. This is the same failure family CLAUDE.md records as the "silently
// sliced ranking": every row shown is correct, the board just stops, and the
// number attached to it is presented as a census.
//
// ── WHY NOT JUST MAKE IT A REAL COUNT ──────────────────────────────────────
// Deliberately NOT fixed by adding `{ count: "exact" }`. These boards are views
// over the hot tables on a 2 GB, disk-IO-throttled instance where the insights
// refresher already fails 4 of 6 board warms per tick; an extra full count on
// every anonymous request would buy a nicer number by making the saturation that
// causes the timeouts worse. Telling the truth about what we DID read costs
// nothing, so that is what this does.
//
// ── THE CONTRACT ───────────────────────────────────────────────────────────
// `total_rows` is KEPT, unchanged, for backward compatibility — the concierge's
// fetchPublicInsight and any external consumer still read it. Two fields are
// ADDED beside it:
//
//   returned_rows — same value, named for what it actually is.
//   truncated     — true when the read filled its cap, i.e. `total_rows` is a
//                   FLOOR and there are more rows we did not fetch.
//
// A caller that wants an honest label should branch on `truncated`, not compare
// counts itself. `boardCountFloor()` below is that label.

export type BoardRowMeta = {
  /** @deprecated Misnamed: this is the returned PAGE length, not a board total.
   *  Kept so existing consumers do not break. Read `returned_rows` + `truncated`. */
  total_rows: number
  /** Rows actually returned by this request. */
  returned_rows: number
  /** True when the read filled its cap — `returned_rows` is a FLOOR, not a total. */
  truncated: boolean
}

/**
 * Build the row-count half of a board's `meta`.
 *
 * ⚠ `limit` must be the CLAMPED limit the query actually ran with, not the raw
 * query-string value. Passing the unclamped input makes `truncated` read false
 * on exactly the requests that were truncated — a caller asking for `limit=5000`
 * against a 200-cap would be told its 200 rows were the whole board.
 */
export function boardRowMeta(rowCount: number | null | undefined, limit: number): BoardRowMeta {
  const n = rowCount ?? 0
  return {
    total_rows: n,
    returned_rows: n,
    // `>=` rather than `===` on purpose: a page can only meet or fall short of
    // its cap, and treating an over-length page as complete is the wrong way to
    // be wrong.
    truncated: n >= limit,
  }
}

/**
 * Row-count meta for a read that paginated through EVERYTHING (fetchAllPaged and
 * friends) rather than taking one capped page.
 *
 * ⚠ Use this only when the read genuinely has no cap. Calling it on a capped
 * read republishes the exact false claim this module exists to remove — and it
 * would do so silently, because the number itself still looks plausible.
 */
export function boardRowMetaComplete(rowCount: number | null | undefined): BoardRowMeta {
  const n = rowCount ?? 0
  return { total_rows: n, returned_rows: n, truncated: false }
}

/**
 * Render a count that may be a floor: `"1,352"` when complete, `"200+"` when the
 * read was capped.
 *
 * The `+` is doing real work — it is the difference between a card claiming a
 * census and a card claiming a minimum. Callers should NOT append their own
 * suffix on top of this.
 */
export function boardCountFloor(count: number, truncated: boolean): string {
  return `${count.toLocaleString("en-US")}${truncated ? "+" : ""}`
}
