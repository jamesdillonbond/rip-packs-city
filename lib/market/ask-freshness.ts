// lib/market/ask-freshness.ts
//
// One spelling of "how old is this ask, and is that old enough to say so".
//
// 🚨 WHY THIS IS A SHARED MODULE AND NOT THREE COPIES (2026-08-29). `edition_offers`
// has ONE writer for the ask side — the `offers-sweep` cron — and when its upstream
// died the whole column froze: 12,259 Top Shot asks at a MEDIAN AGE of 30.0 h, p90
// 30.3 h, 150 of 12,259 refreshed in twelve hours. Every surface reading `low_ask`
// kept rendering those numbers as current. The deals board was hardened first and
// grew its own local helpers; the edition page and the Bid-vs-Floor board needed the
// same logic, and CLAUDE.md's rule for this is explicit — *when you find one, grep
// for the EXPRESSION, not the file; it has spread by copy-paste five times now.*
// So the threshold and the formatter live here, once.
//
// ⚠ THE CONTRACT IS "REPORTS, NEVER CONCLUDES." An old ask is not a gone ask. These
// helpers answer *when did we last confirm this*, and callers must phrase it that
// way — "unconfirmed 30h", never "sold" or "no longer listed", neither of which we
// checked.
//
// ⚠ `now` IS A PARAMETER WITH A DEFAULT, deliberately, and that is what keeps this
// out of `__tests__/insights-client-dates-are-hydration-safe-guard.test.ts`'s
// site-wide Rule C ratchet: a CLIENT caller must pass a hydration-safe clock (a
// server-serialised prop, or post-mount state) rather than reading the wall clock
// during render. A SERVER caller may take the default — the same arrangement
// `relTime` in components/entity/_shared.tsx already uses. Passing `null` yields
// `null`, so a client that has not mounted yet renders no marker rather than a
// wrong one.

/**
 * Hours past which an ask is called out as unconfirmed.
 *
 * ⚠ 12 h is deliberately FAR above the healthy cadence, not near it. A healthy
 * `offers-sweep` wraps the whole Top Shot catalogue 8-18 times a day, so a
 * genuinely fresh ask is minutes-to-an-hour old and 12 h cannot fire on one. The
 * gap is the point: this marker is for an ask nobody has looked at since the last
 * working sweep, not for ordinary jitter between wraps.
 */
export const ASK_STALE_HOURS = 12

/**
 * Age of an ask in hours, or `null` when it cannot be known.
 *
 * ⚠ THREE STATES, NOT TWO — the caller must be able to tell them apart:
 *   - a number  → we know when this was last confirmed
 *   - `null`    → we do NOT know (no timestamp, an unparseable one, or a client
 *                 that has not mounted and so has no clock yet)
 * `null` must render as NO MARKER. It must never render as "fresh": that would be
 * the failed-read-as-answer shape, one layer down.
 */
export function askAgeHours(
  iso: string | null | undefined,
  now: number | null = Date.now(),
): number | null {
  if (now === null || !iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return (now - t) / 3_600_000
}

/** True only when the age is KNOWN and past the threshold. Unknown is not stale. */
export function isAskStale(iso: string | null | undefined, now: number | null = Date.now()): boolean {
  const h = askAgeHours(iso, now)
  return h !== null && h >= ASK_STALE_HOURS
}

/** Compact age for a 10px caption: `30h` under two days, `3d` beyond. */
export function fmtAskAge(hours: number): string {
  return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`
}

/**
 * The tooltip every ask-age marker should carry, so the wording cannot drift
 * between surfaces. Says what we measured and what the reader should do; does not
 * assert anything about the listing itself.
 */
export function askAgeTitle(hours: number): string {
  return (
    `We last confirmed this ask ${fmtAskAge(hours)} ago; normally every edition is ` +
    `re-checked about hourly. It may already be sold or repriced — open the listing before acting.`
  )
}

/**
 * The timestamp that actually describes the ask a surface is about to render, or
 * `null` when no timestamp describes it.
 *
 * 🚨 THE PROVENANCE CHECK IS LOAD-BEARING, NOT DEFENSIVE, and it is a function
 * rather than an inline `&&` so it can be tested against the case that motivates
 * it. Surfaces resolve the displayed ask through a fallback chain — the edition
 * page's is `edition_offers.low_ask ?? fmv.cross_market_ask` — while the only
 * timestamp in hand belongs to the FIRST link. Stamping the fallback with it would
 * attach a real-looking, precise age to a number it says nothing about, which is
 * strictly worse than showing no age: a wrong provenance claim is unfalsifiable by
 * the reader, whereas a missing one is merely silent.
 *
 * So: a timestamp is returned ONLY when the offers row is the source of the value.
 * A row that has an `updated_at` but no `low_ask` returns `null` — that timestamp
 * describes when we last looked at the OFFER side, not an ask we never had.
 */
export function askVerifiedAt(
  offers: { low_ask?: number | null; updated_at?: string | null } | null | undefined,
): string | null {
  if (!offers || offers.low_ask == null) return null
  return offers.updated_at ?? null
}
