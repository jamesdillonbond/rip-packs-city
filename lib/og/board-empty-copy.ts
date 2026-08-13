// Honest empty/failure copy for the /insights Open Graph cards.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// Fifteen insights OG cards rendered the SAME line whenever they had no rows:
//
//     Loading the live board…
//
// An OG card is a static PNG. By the time that string is rendered the fetch has
// already finished — nothing is loading, and nothing ever will be. Worse, these
// images are edge-cached, so a card generated during a five-minute outage can
// keep telling every social feed that the board is "loading" long after it
// recovered. The one thing the copy asserts is the one thing that cannot be true.
//
// It was also the same string in BOTH branches, which is this repo's most-repeated
// class: a failed read and an empty result rendered identically, so a reader
// cannot tell "there is nothing to show" from "we could not ask". The same
// conflation has now been fixed at the API layer (lib/api-error.ts), the server-
// page layer (lib/insights/board-status.ts), the client layer
// (lib/analytics/fetch-json.ts) and the concierge prompt. This is the OG layer.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
// `fetched` answers "did we successfully read the board?", NOT "did we get rows".
// It must be set to true INSIDE the `if (res.ok)` branch, at the point the rows
// were actually parsed — not at the top of the try, and not after the catch.
//
//   fetched === true   → we asked and the honest answer is zero rows.
//   fetched === false  → we could not ask. Say so, and point at the live page,
//                        which is not cached and will have the real answer.
//
// ⚠ Note what is deliberately NOT here: a retry, a spinner, or any wording that
// implies the card will update. It will not. A card is generated once and cached.

/**
 * @param fetched true when the board read SUCCEEDED (even with zero rows).
 * @param noun    what this card is showing — "board", "cohort", "tracker",
 *                "index". Kept per-card because the cards already differ and a
 *                forced-generic noun would read worse, not better.
 */
export function boardEmptyCopy(fetched: boolean, noun: string = "board"): string {
  return fetched
    ? `Nothing qualifying on the ${noun} right now.`
    : `Couldn't load the live ${noun} — open the page for current data.`
}
