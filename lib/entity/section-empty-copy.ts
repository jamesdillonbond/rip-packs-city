// The copy an entity-page section shows when it has no rows to render.
//
// ── Why this is a helper and not three inline strings ──────────────────────
// `lib/entity-section-rpc.ts` degrades a DECORATIVE section to `[]` when its RPC
// fails after retries. That is a deliberate policy and it stays. What was not
// deliberate is what the reader then saw: `[]` reached the render layer with no
// way to tell "we looked and there are none" from "we could not look", so the
// components concluded — "No sales yet.", "No open offers on this edition.",
// "No recent sales." — out of a failed read.
//
// Measured 2026-08-21 in Vercel runtime errors over 24h: `get_edition_recent_sales`
// 124 + 97, `get_player_top_sales` 254, `get_edition_offers` 60,
// `get_edition_fmv_history` 62, `get_edition_special_serials` 53,
// `get_edition_in_packs` 51, `get_edition_parallels` 47 — every one of them
// "degrading to empty", on public SEO pages.
//
// ⚠ THE EMPTY COPY IS UNCHANGED ON PURPOSE. Each caller keeps its own wording for
// the genuinely-empty case; only the DEGRADED case is new. Rewriting the honest
// empty strings here would be a second, unrelated change smuggled in behind a
// correctness fix — and a section that quietly says "unavailable" when it is
// merely quiet is the same defect pointed the other way.
//
// The canon's four layer-helpers (`apiErrorResponse`, `summarizeDegraded`,
// `fetchJson`, `boardEmptyCopy`) do not cover an entity-page section, which is why
// this is a fifth ENTRY POINT rather than a fifth POLICY: it makes exactly one
// decision — what a degraded section says — and holds it in one place so the next
// section cannot invent its own phrasing.

/**
 * What a section shows when it has no rows because the read FAILED.
 *
 * @param noun A capitalised subject, e.g. "Recent sales", "Offers", "Top sales".
 *             It leads the sentence, so it must read naturally in that position.
 */
export function sectionUnavailableCopy(noun: string): string {
  return `${noun} couldn't be loaded — refresh to try again.`
}

/**
 * The whole decision in one call: pick the copy for a section with no rows.
 *
 * @param ok    `false` only when the read itself failed (see `sectionRowsResult`).
 *              A genuinely empty section passes `true`.
 * @param noun  Subject for the degraded sentence.
 * @param empty The caller's own wording for a genuinely empty section.
 */
export function sectionEmptyCopy(ok: boolean, noun: string, empty: string): string {
  return ok ? empty : sectionUnavailableCopy(noun)
}
