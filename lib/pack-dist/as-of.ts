// AS-OF LABELS FOR THE PACK-DISTRIBUTION SURFACE.
//
// WHY THIS EXISTS (measured 2026-09-11 PT, register #74). Every depletion and
// packs-remaining figure this site renders for NBA Top Shot and NFL All Day is
// derived from a supply counter whose refresh lane is dead, and NO surface
// states the age:
//
//   · topshot_pack_supply  — 2,085 rows, newest SUCCESSFUL fetch 2026-08-26,
//                            median updated_at 2026-06-28 (2,068 of 2,085 older
//                            than 30 days).
//   · allday_pack_supply   — 3,195 rows on exactly TWO distinct days: 3,020 at
//                            2026-06-30 (the one-shot hydration) and 175 at
//                            2026-09-01 (the repair in migration 20260901071258,
//                            whose own header says "THIS IS A REPAIR, NOT THE
//                            FIX — the hydrator will freeze again the moment it
//                            finishes"). It has.
//   · pack_distributions.metadata->>'tier_counts_updated_at' (the v20 EV sweep's
//                            per-pack tier counts) — 823 of 2,099 Top Shot dists
//                            carry it, newest 2026-08-28, and ZERO are fresher
//                            than 7 days.
//
// ⚠ THE THIRD ONE WAS NOT MERELY SILENT, IT WAS WRONG. The Depletion tile
// rendered the sub-label "live pool" whenever tier_counts_updated_at existed,
// with no age check anywhere in the branch — a positive freshness claim over
// data that is at minimum 15 days old. That is this repo's #1 defect class (a
// surface publishing a claim the read does not support), so the label is gone:
// the age is now STATED rather than asserted. The page's own EV-staleness
// caveat already had the right instinct — "a reader can only judge a stale
// number if they are told how stale" — and this generalises it to the two
// counters beside it.
//
// ⚠ NOT CLAIMED — that any rendered number is wrong. Pack supply is slow-moving
// and a closed drop's mint count may well still be correct. What was true before
// this module is that a 73-day-old figure and a fresh one were INDISTINGUISHABLE
// on the page. That is what an as-of fixes.
//
// ⚠ PROVENANCE IS PER-NUMBER, NOT PER-PAGE. The Depletion tile has three
// possible sources (All Day's opened_count, the v20 tier counts, and the cached
// depletion_pct) and they have three different ages. Each call site passes the
// stamp belonging to the number it is rendering — pairing a count from one
// source with an age from another is the trap CLAUDE.md names under measurement
// discipline, and it would be worse than showing nothing.

import { fmtAge, minutesSince } from "@/lib/collection-overview-format"

/**
 * "as of 15d ago" for a stamp we have; `null` for one we do not.
 *
 * ⚠ NULL IS A REAL ANSWER AND MUST STAY DISTINCT FROM "0m ago". A caller that
 * rendered a missing stamp as "just now" would invent the freshness this module
 * exists to stop inventing, so an absent/unparseable/blank stamp returns null
 * and the caller omits the clause entirely. `fmtAge(minutesSince(...))` alone
 * cannot be used for this: it collapses null to an em-dash, which reads as a
 * rendered value rather than an absence.
 */
export function asOfLabel(iso: string | null | undefined): string | null {
  const minutes = minutesSince(iso)
  if (minutes == null) return null
  return `as of ${fmtAge(minutes)}`
}

/**
 * Join a provenance noun to its age: `withAsOf("pool", stamp)` → "pool · as of 15d ago".
 *
 * Both halves are independently optional, and all four combinations are real on
 * this page:
 *   noun + age   the normal case.
 *   noun only    we know WHERE the number came from but not WHEN — the noun is
 *                still true, so it is kept and nothing is invented.
 *   age only     the tile's own value already says what the number is (the
 *                packs-remaining count with no minted denominator), so the age
 *                stands alone rather than being dropped for want of a noun.
 *   neither      `null`, which callers pass straight to `sub` as undefined. An
 *                empty string would render an empty sub-line.
 */
export function withAsOf(label: string | null | undefined, iso: string | null | undefined): string | null {
  const age = asOfLabel(iso)
  const noun = label && label.trim() ? label : null
  if (noun && age) return `${noun} · ${age}`
  return noun ?? age ?? null
}

// ── WHICH STAMP BELONGS TO WHICH NUMBER ─────────────────────────────────────
// These two selectors live here rather than inline in the page for the reason
// lib/pack-dist/fetchers.ts's own header gives: `app/**/page.tsx` is measured by
// NEITHER coverage gate, so branch logic left there is unwatched. They are pure,
// take every input explicitly, and mirror — branch for branch — the expressions
// in the page that produce the numbers they date. If one of those expressions
// changes and its twin here does not, the page shows an age belonging to a
// different read, which is the one outcome worse than showing no age.

/** The three reads that can produce a depletion figure, in the page's own order. */
export interface DepletionSources {
  /** true for the All Day path, which reads correctedEv (allday_pack_supply). */
  isAllDay: boolean
  /** pack_table_rows.supply_as_of — dates total_minted / total_opened. */
  supplyAsOf: string | null
  /** pack_table_rows.depletion_as_of — dates depletion_pct, branch-matched in SQL. */
  depletionAsOf: string | null
  /** metadata.tier_counts_updated_at — dates the v20 sweep's per-pack tier counts. */
  tierCountsUpdatedAt: string | null
  /** metadata.total_pack_count, the v20 denominator. */
  metaTotalPackCount: number | null
  /** metadata.total_unopened, the v20 numerator. */
  metaTotalUnopened: number | null
}

/**
 * Stamp for the Depletion tile.
 *
 * Mirrors `displayDepletionPct`: All Day reads correctedEv.opened_pct_of_minted
 * (so the All Day supply stamp), any other collection prefers the v20
 * metadata-derived figure (so the tier-counts stamp) and otherwise falls back to
 * the cached depletion_pct (so the SQL-side branch-matched stamp).
 */
export function depletionTileAsOf(s: DepletionSources): string | null {
  if (s.isAllDay) return s.supplyAsOf
  if (s.metaTotalPackCount != null && s.metaTotalPackCount > 0 && s.metaTotalUnopened != null) {
    return s.tierCountsUpdatedAt
  }
  return s.depletionAsOf
}

/**
 * Stamp for the "Packs remaining / of N minted" tile.
 *
 * ⚠ THIS TILE RENDERS TWO NUMBERS AND ONLY DATES THEM WHEN THEY SHARE A READ.
 * `effectiveUnopened` can come from All Day's correctedEv while
 * `effectiveTotalMinted` comes from the v20 metadata; one stamp over a mixed
 * pair would be a claim about a number it does not describe, so the mixed case
 * returns null and the tile shows no age — the same answer it gave before this
 * module existed, which is the correct floor.
 */
export function packsRemainingTileAsOf(s: {
  supplyAsOf: string | null
  tierCountsUpdatedAt: string | null
  allDayUnopened: number | null
  allDayTotalMinted: number | null
  metaTotalUnopened: number | null
  metaTotalPackCount: number | null
}): string | null {
  if (s.allDayUnopened != null && s.allDayTotalMinted != null) return s.supplyAsOf
  if (s.metaTotalUnopened != null && s.metaTotalPackCount != null) return s.tierCountsUpdatedAt
  return null
}
