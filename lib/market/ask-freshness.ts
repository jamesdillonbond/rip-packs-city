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
 * ⚠ 12 h was chosen to sit FAR above the healthy cadence, not near it: a healthy
 * `offers-sweep` wrapped the whole Top Shot catalogue 8-18 times a day, so a
 * genuinely fresh ask was minutes-to-an-hour old and 12 h could not fire on one.
 *
 * 🚨 THAT JUSTIFICATION IS DEAD FOR TOP SHOT AND THE CONSTANT IS KEPT ANYWAY —
 * re-measured 2026-09-13, sixteen days after `offers-sweep` stopped writing. Under
 * the change-stamp that replaced it, **10,142 of 12,955 Top Shot asks (78%) are
 * past 24 h**, so on that arm this marker is near-always-on and its firing carries
 * almost no information. It is still not FALSE — the `"changed"` copy below says
 * exactly what the stamp means — so lowering or raising the number fixes nothing:
 * the marker is reporting truthfully about a column that no longer records
 * re-observation. The real repair is a Top Shot *checked* stamp
 * (`topshot_atlas_edition_verified.verified_at` plumbed into `edition_offers`,
 * specified in known-issues #98), after which this arm becomes `"checked"` and
 * 12 h means what it says again. Until then: do not read a Top Shot marker as
 * evidence the lane is broken, and do not tune this constant in place of fixing
 * the stamp.
 *
 * ⓘ The other two arms are unaffected — their stamps were never sweep times.
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
 * WHAT AN ASK TIMESTAMP ACTUALLY MEANS, PER COLLECTION.
 *
 * 🚨 THIS EXISTS BECAUSE THE OLD TOOLTIP WAS FALSE ON THE BIGGEST COLLECTION, AND
 * HAD BEEN SINCE 2026-08-28 (found 2026-09-13). It read *"We last confirmed this
 * ask Nh ago; normally every edition is re-checked about hourly"* on every surface.
 * Both halves are wrong for Top Shot:
 *
 *   · `edition_offers.updated_at` is written by `sync_edition_offers_from_atlas()`
 *     under `ON CONFLICT … WHERE low_ask IS DISTINCT FROM EXCLUDED.low_ask` — so it
 *     is bumped ONLY WHEN THE FLOOR CHANGES, never merely on re-observation. It is
 *     a **last-changed** stamp wearing a **last-confirmed** name. (It is also
 *     bumped by `raise_edition_offers_from_chain()` when the OFFER side moves,
 *     which is not the ask at all.)
 *   · "about hourly" described `offers-sweep`, which wrapped the catalogue 8-18x a
 *     day and stamped every row it touched. That lane has written NOTHING since
 *     2026-08-28 (register #81), and the Atlas writer that replaced it does not
 *     stamp on re-observation. **The column silently changed meaning when its
 *     writer was replaced, because the name did not change.**
 *
 * ⭐ THE OTHER ARMS ARE GENUINELY DIFFERENT, so one sentence cannot be true of all
 * three — which is why this is a parameter and not a constant:
 *   · `disney_pinnacle` — `pinnacle_catalog_set_floor_asks()` writes
 *     `floor_ask_updated_at = p_checked_at` on EVERY row every sweep (its own
 *     comment says `= freshness`). A real **checked** stamp.
 *   · `nfl_all_day` / `laliga_golazos` — `cached_listings_v2.listed_at`, when the
 *     SELLER posted it, over an index a row LEAVES when the listing closes. A
 *     **listed** stamp; an old one describes a live listing, not a neglected one.
 *   · `candy_mlb` — `candy_listings.last_seen_at`, written as
 *     `new Date().toISOString()` on EVERY row the Magic Eden sweep upserts, not
 *     only when the price moves. A real **checked** stamp, same shape as
 *     Pinnacle's. ⚠ Added 2026-09-19 because the unknown-collection fallback
 *     was giving Candy the `changed` wording — *"This ask last changed Nh ago
 *     — that is when the price moved, not when we last re-checked it"* — which
 *     is the exact inverse of what `last_seen_at` records. The fallback is
 *     doing its job (the weakest claim), but a named collection must be named.
 *     ⛔ AND THE AGE MATTERS HERE MORE THAN ANYWHERE: Candy deactivation is
 *     EVIDENCE-BASED, never absence-based (the 2026-07-27 incident, where an
 *     absence-based sweep destroyed 419 standing asks), and Magic Eden listings
 *     carry NO expiry — measured 2026-09-19, `expiry IS NULL` on 217 of 217.
 *     So a listing whose ending event fell outside the bounded activities walk
 *     stays `is_active` forever: **217 of 1,997 active Candy listings (10.9%)
 *     had not been seen in 7+ days, 216 of them in 30+ days, the oldest 55
 *     days, carrying $46,385 of ask value.** That is not a bug to fix by
 *     deactivating on absence — it is a bug to fix by SAYING SO.
 *
 * ⚠ UNKNOWN FALLS BACK TO THE WEAKEST CLAIM (`changed`), deliberately: a new
 * collection must not inherit a freshness promise nobody has checked for it.
 */
export type AskStampKind = "changed" | "checked" | "listed"

/** Resolve the stamp's meaning from a collection slug. Accepts either spelling
 *  convention (`nba_top_shot` / `nba-top-shot`) — both are live in this codebase. */
export function askStampKind(collectionSlug: string | null | undefined): AskStampKind {
  const s = (collectionSlug ?? "").replace(/-/g, "_").toLowerCase()
  if (s === "nfl_all_day" || s === "laliga_golazos") return "listed"
  if (s === "disney_pinnacle" || s === "candy_mlb") return "checked"
  return "changed"
}

/**
 * The tooltip every ask-age marker should carry, so the wording cannot drift
 * between surfaces. Says what we measured and what the reader should do; does not
 * assert anything about the listing itself.
 *
 * ⚠ `kind` IS REQUIRED, not defaulted. A default would let a call site keep the
 * old, false promise silently; making it required means the compiler names every
 * surface that has to decide. ⛔ No variant may claim a re-check CADENCE —
 * `__tests__/ask-freshness.test.ts` bans the word, because the cadence claim is
 * what made the previous version false without anyone editing it.
 */
export function askAgeTitle(hours: number, kind: AskStampKind): string {
  const age = fmtAskAge(hours)
  const caveat = "It may already be sold or repriced — open the listing before acting."
  if (kind === "checked") return `We last checked this ask ${age} ago. ${caveat}`
  if (kind === "listed") {
    return `This listing was posted ${age} ago and our index still shows it open. ${caveat}`
  }
  return (
    `This ask last changed ${age} ago — that is when the price moved, not when we ` +
    `last re-checked it. ${caveat}`
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

/**
 * The whole ask-age stamp decision, as data — so the surfaces stay dumb and the
 * coverage gate can measure the rule.
 *
 * Extracted 2026-09-19 when the Market tab finally got a stamp: the decision has
 * three moving parts (is there a timestamp, does it describe the value being
 * rendered, is it past the staleness threshold) and putting them inline in a
 * .tsx would have left the rule untested on the surface with the most listings.
 *
 * ⚠ `askPrice` IS A REQUIRED INPUT, not a convenience. The timestamp describes
 * an ASK; with no ask on the row there is nothing for it to describe, and
 * stamping the absence with a real-looking age is a claim the reader cannot
 * falsify. Same argument as `askVerifiedAt` above, one surface down.
 *
 * Returns null when no stamp is honest.
 */
export function askAgeStamp(
  cachedAt: string | null | undefined,
  askPrice: number | null | undefined,
  collectionSlug: string | null | undefined,
  now: number | null = Date.now(),
): { label: string; title: string; stale: boolean } | null {
  if (!cachedAt || askPrice == null) return null
  const hours = askAgeHours(cachedAt, now)
  if (hours == null) return null
  const stale = hours >= ASK_STALE_HOURS
  return {
    label: `${stale ? "⚠ " : ""}${fmtAskAge(hours)} old`,
    title: askAgeTitle(hours, askStampKind(collectionSlug)),
    stale,
  }
}

