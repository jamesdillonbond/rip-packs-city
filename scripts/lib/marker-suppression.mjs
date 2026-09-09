// scripts/lib/marker-suppression.mjs
//
// THE one inline-suppression reader for source-shape guards.
//
// A guard that bans a source shape needs an escape hatch for the case that is
// genuinely deliberate, and this repo settled on the same one twice already:
// an inline marker (`fabricated-divisor: intentional`, `brand-exception`) that
// a reader meets AT the offending line rather than in a file list somewhere
// else. CLAUDE.md's rule is why — "make SUPPRESSION the curated list", and a
// guard that NAMES its instances dies on a rename (three have here).
//
// ── WHY THIS IS SHARED AND NOT COPIED ───────────────────────────────────────
// The window semantics below are not obvious, and both of them were bought by
// a failure in `no-fabricated-divisor-ratchet`:
//
//   1. A same-line-only window is unusable. The banned expressions routinely
//      WRAP, so the marker lands on a different line from the match, and an
//      escape hatch that cannot be reached in the common case just teaches
//      people to delete the guard. Hence the fixed lookback.
//   2. A fixed lookback of 3 is too small for a justification worth honouring.
//      Two suppressions written on 2026-09-07 were SILENTLY IGNORED by the
//      3-line rule — the author believed the marker took, and it did nothing,
//      which is worse than no hatch at all. Hence the union with the
//      contiguous comment block above.
//   3. The block walk stops at the FIRST non-comment line, so — unlike simply
//      raising the fixed number — a marker can never reach across code to
//      excuse something below it.
//
// Copying that into a second guard would mean re-earning all three. Same
// reasoning as `strip-comments.mjs`: one implementation to fix when it is
// wrong. ⚠ Do NOT re-inline a local copy.

/** Default lookback for the fixed window, in lines above the match. */
export const DEFAULT_LOOKBACK = 3

/**
 * Is the match at RAW line index `i` suppressed by `marker`?
 *
 * @param {string[]} rawLines  the file's RAW lines (never comment-stripped —
 *   the marker lives IN a comment, so a stripped copy can never contain it).
 * @param {number} i           0-based index of the offending line.
 * @param {RegExp} marker      the guard's marker pattern.
 * @param {number} [lookback]  fixed window size above the match.
 */
export function isMarkerSuppressed(rawLines, i, marker, lookback = DEFAULT_LOOKBACK) {
  if (rawLines.slice(Math.max(0, i - lookback), i + 1).some((l) => marker.test(l))) return true
  for (let j = i - 1; j >= 0; j--) {
    const t = (rawLines[j] ?? "").trim()
    if (!(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"))) return false
    if (marker.test(rawLines[j])) return true
  }
  return false
}

export default isMarkerSuppressed
