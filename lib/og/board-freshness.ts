// lib/og/board-freshness.ts
//
// How OLD is the data behind an insights OG card?
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// The OG layer already refuses to publish a FAILED read as an answer
// (lib/og/board-empty-copy.ts). It had no answer for the third state: a read
// that SUCCEEDED against a spine nothing has refreshed in a day.
//
// The live case is the Underpriced #1s card. `topshot_underpriced_serials_board`
// gates on `l.active`, and `active` is cleared only by
// `deactivate_stale_topshot_active_listings`, which runs ONLY ON A SUCCESSFUL
// INGEST. So when the ingest fails, `active` FREEZES: sold and delisted moments
// stay on the board, and the row count stays reassuringly non-zero. The count is
// not fabricated — those are real `active` rows — but "Live deals" over them is
// an unbounded liveness claim, and an OG card is the widest-reach surface there
// is (Twitter / iMessage / Slack previews) and is edge-cached on top.
//
// ⚠ The ingest is genuinely intermittent BY DESIGN, not only when broken: it
// runs ~every 3h from a Windows Scheduled Task on a residential box (Atlas
// WAF-blocks datacentre IPs, so this is the arm that actually feeds the board)
// and it can skip overnight. Measured gap distribution 2026-08-16: min 3h /
// median 6h / p90 22h / max 26.7h. A card that says "live" at hour 22 is wrong.
//
// ── THE THRESHOLD IS COPIED, NOT INVENTED ──────────────────────────────────
// 4 hours, from app/insights/underpriced-serials/UnderpricedSerialsBoardClient.tsx,
// which has rendered "Listings last refreshed {N}h ago" at >= 4h since 2026-08-16.
// The page and its own social card disagreeing about whether the board is live
// is exactly the "fix per PANEL, not per page" defect this repo keeps re-finding.
// ⚠ Do NOT raise it toward the concierge's 36h `feed_stale` and call that
// consistent — those two numbers answer different questions. 36h is "stop
// trusting this feed at all" (set high on the `ufc_fmv_stale_hours` cry-wolf
// precedent); 4h is "stop calling it live". This module is the second question.

/**
 * Age, in hours, of the freshest row in `rows` — i.e. how long ago the spine
 * behind this board was last refreshed.
 *
 * Returns `null` when no row carries a parseable timestamp, which INCLUDES the
 * failed-read and empty-board cases. `null` means "unknown", never "fresh":
 * callers must not fall through to a liveness claim on it.
 *
 * ⚠ MAX, not min. Every row's `last_seen_at` is a lower bound on when the
 * ingest last ran, so the newest one is the tightest bound available and the
 * derived age is an UPPER bound on the true age — it can overstate staleness,
 * never understate it. That is the safe direction for a claim about liveness.
 */
export function boardMaxAgeHours(
  rows: ReadonlyArray<unknown>,
  field: string,
  nowMs: number = Date.now(),
): number | null {
  let newest = 0
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const raw = (row as Record<string, unknown>)[field]
    if (typeof raw !== "string") continue
    const t = Date.parse(raw)
    if (Number.isFinite(t) && t > newest) newest = t
  }
  if (!newest) return null
  // A clock skew that puts the spine in the future is not freshness evidence
  // either way; clamp at 0 rather than rendering a negative age.
  return Math.max(0, (nowMs - newest) / 3_600_000)
}

/**
 * The card's liveness line, in three states — never two.
 *
 *   age >= threshold  → the bounded claim: "Listings last refreshed 22h ago"
 *   age <  threshold  → the live claim, `freshLabel`
 *   age === null      → NEITHER. We could not establish the age, so we do not
 *                       get to assert liveness. Returns `null` and the caller
 *                       renders its remaining copy without a liveness claim.
 *
 * @param noun what the timestamps describe, e.g. "Listings".
 */
export function boardLivenessLabel(
  ageHours: number | null,
  freshLabel: string,
  noun: string = "Listings",
  thresholdHours: number = 4,
): string | null {
  if (ageHours == null) return null
  if (ageHours < thresholdHours) return freshLabel
  return `${noun} last refreshed ${Math.round(ageHours)}h ago`
}
