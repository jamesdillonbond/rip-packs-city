// lib/market/bid-age.ts
//
// How long the top bid on an edition has been standing, and — just as
// important — when we cannot say.
//
// The number comes from `edition_offers.best_offer_at`, which is the BLOCK
// timestamp of the OfferAvailable event for the open on-chain offer whose
// amount equals the bid being displayed (see the column comment and
// audit_20260914). So it is the age of THAT bid, not of our record of it.
//
// ⚠ NULL IS "UNAGEABLE", NEVER "NEW" — and the two are indistinguishable from
// the value alone, which is why this module refuses to format a missing value
// as anything but unknown. Two causes:
//   (a) the on-chain offers indexer is forward-only from a ~8 h backfill
//       (2026-06-03 onward), so an older offer has no row at all; and
//   (b) the chain's best open offer may not equal the displayed highest_offer,
//       in which case attaching one's age to the other's price would fabricate
//       a pairing.
// Measured at first write: 3,914 of 7,775 editions with a bid are ageable
// (50.3%), median 12.8 days, p90 58.0 days.

/**
 * Past this, a standing bid is old enough to be worth flagging. 14 days sits
 * just above the measured median (12.8 d), so the marker means "older than the
 * typical standing bid" rather than firing on half the board.
 */
export const BID_STALE_DAYS = 14

/** Whole days since the bid landed, or null when it cannot be aged. */
export function bidAgeDays(
  iso: string | null | undefined,
  now: number | null = Date.now(),
): number | null {
  if (!iso || now === null) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const days = (now - t) / 86_400_000
  // A bid stamped in the future is a clock or ingest fault, not a fresh bid.
  // Report it as unageable rather than rendering a negative age.
  if (days < 0) return null
  return Math.floor(days)
}

/** "today" | "3d" | "5w" | "7mo" — compact enough for a table cell. */
export function fmtBidAge(days: number): string {
  if (days <= 0) return "today"
  if (days === 1) return "1d"
  if (days < 14) return `${days}d`
  if (days < 60) return `${Math.floor(days / 7)}w`
  return `${Math.floor(days / 30)}mo`
}

export function isBidStale(
  iso: string | null | undefined,
  now: number | null = Date.now(),
): boolean {
  const d = bidAgeDays(iso, now)
  return d !== null && d >= BID_STALE_DAYS
}

/** Hover copy for an aged bid. Reports; never concludes the bid is dead. */
export function bidAgeTitle(days: number): string {
  return (
    `This bid has stood on chain for ${days === 1 ? "1 day" : `${days} days`} ` +
    `without being accepted (from the OfferAvailable block timestamp). ` +
    `It is still open — age is not a claim that it will not fill.`
  )
}

/**
 * Why an age is missing. Shown on hover so a reader never has to guess whether
 * "unknown" means new, zero, or broken.
 */
export const BID_AGE_UNKNOWN_TITLE =
  "We cannot date this bid. Our on-chain offer index starts 2026-06-03, and we only " +
  "attach an age when the chain's best open offer matches the bid shown — so an older " +
  "bid, or one we cannot match exactly, is left undated rather than guessed at."

export const BID_AGE_UNKNOWN_LABEL = "unknown"
