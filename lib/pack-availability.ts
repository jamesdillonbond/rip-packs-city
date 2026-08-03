// lib/pack-availability.ts
//
// Two honesty concerns about every pack EV we publish:
//   1. CAN ANYONE ACT ON IT?  A pack that is neither on sale primary nor listed
//      on secondary is a historical record, not a buying opportunity.
//   2. WHAT POOL WAS IT COMPUTED OVER?  Top Shot prices off the REMAINING pool.
//      All Day and Golazos price off the ORIGINAL minted supply, which is a
//      materially different -- and, on a drained pack, materially wrong -- claim.
//
// Neither fact was surfaced anywhere in the UI. Both are cheap to state, and
// stating them is the difference between "here is a pack you should buy" and
// "here is what this pack was worth".
//
// MEASURED LIVE 2026-08-02 (pack_ev_latest, 4,596 rows)
//   Purchasable (primary_available OR secondary_available):
//     nba_top_shot     1 primary + 713 secondary of 1,202
//     nfl_all_day      0 of 3,111
//     laliga_golazos   0 of   202
//     disney_pinnacle  0 of    81
//   So every single All Day, Golazos and Pinnacle pack EV on the site describes a
//   pack nobody can buy -- 3,394 of 4,596 rows. Only 108 rows are simultaneously
//   purchasable, under 90% depleted, and at 80%+ FMV coverage.
//
//   Pinnacle is the sharpest case: all 81 of its rows carry a non-null pack_ev
//   AND value_ratio, i.e. we assert a margin against a retail price for packs
//   that cannot be bought. (The 3,071 rows with a NULL pack_ev are the deliberate
//   and correct behaviour -- no price, so no margin asserted. That stays.)
//
// EV BASIS, measured the same day over pack_drop_pool:
//   nfl_all_day     89,783 of 89,783 rows still at orig_drop_weight  (100%)
//   laliga_golazos   1,957 of  1,957 rows still at orig_drop_weight  (100%)
//   nba_top_shot       468 of 60,990                                 (0.8%)
//   i.e. the All Day and Golazos remaining pools have NEVER been decremented, so
//   `compute_pack_ev_per_edition_weighted` weights them by original mint supply.
//   Top Shot is hard-coded to the remaining pool. This is not a bug we can fix by
//   fabricating a remaining pool -- it is a limit of the data we have -- so the
//   honest move is to DISCLOSE the basis. See docs/handoff-2026-07-31-pack-remaining-pool.md.

/** What a reader can actually do with this pack right now. */
export type PackAvailability = "primary" | "secondary" | "retired"

export interface PackAvailabilityInfo {
  status: PackAvailability
  /** Short badge text. */
  label: string
  /** Tooltip / long form. */
  note: string
  /** True when no EV on this row should be read as a buy signal. */
  historical: boolean
}

/** The subset of a pack row this needs. Structural, so any row shape fits. */
export interface PackAvailabilityInput {
  primary_available?: boolean | null
  secondary_available?: boolean | null
}

/**
 * Classify a pack row. `primary_available` / `secondary_available` come straight
 * from pack_table_rows / pack_ev_latest and are defined in lib/pack-ev-pricing.ts
 * as "still has unopened supply and is flagged for sale" and "has a live
 * secondary ask above zero" respectively.
 */
export function derivePackAvailability(row: PackAvailabilityInput): PackAvailabilityInfo {
  if (row?.primary_available === true) {
    return {
      status: "primary",
      label: "On sale",
      note: "This pack is still available in the primary drop.",
      historical: false,
    }
  }
  if (row?.secondary_available === true) {
    return {
      status: "secondary",
      label: "Secondary only",
      note: "The primary drop is finished. This pack is only obtainable from a secondary listing.",
      historical: false,
    }
  }
  return {
    status: "retired",
    label: "Retired",
    note:
      "This pack is not on sale and has no live secondary listing, so it cannot currently be bought. " +
      "Its expected value is a historical record of what the pack held, not a buying opportunity.",
    historical: true,
  }
}

/** Which pool the pack EV for a collection is weighted by. */
export type PackEvBasis = "remaining" | "original"

export interface PackEvBasisInfo {
  basis: PackEvBasis
  label: string
  note: string
}

const REMAINING: PackEvBasisInfo = {
  basis: "remaining",
  label: "Remaining pool",
  note:
    "Expected value is weighted by what is LEFT in the pack's pool, so editions that have already " +
    "been pulled out no longer count toward it.",
}

const ORIGINAL: PackEvBasisInfo = {
  basis: "original",
  label: "Original supply",
  note:
    "We have no record of this pack's pool being drawn down, so expected value is weighted by the " +
    "ORIGINAL minted supply rather than what is left. On a pack that has already been heavily opened " +
    "that overstates the chance of pulling a card that is largely gone. Treat it as the value of the " +
    "pack as printed, not as the value of a pack bought today.",
}

/**
 * Keyed by the frontend hyphen slug used across the pack surfaces.
 * Top Shot is hard-coded to the remaining pool inside
 * compute_pack_ev_per_edition_weighted; every other collection falls back to the
 * original mint weights whenever orig_drop_weight is present, which for All Day
 * and Golazos is 100% of pool rows.
 */
const PACK_EV_BASIS_BY_SLUG: Record<string, PackEvBasisInfo> = {
  "nba-top-shot": REMAINING,
  "nfl-all-day": ORIGINAL,
  "laliga-golazos": ORIGINAL,
}

/**
 * The EV basis for a collection, or null when we do not model a drop pool for it
 * at all. Disney Pinnacle is deliberately absent: its EV comes from the
 * render-keyed compute-pinnacle-pack-ev pipeline and not from pack_drop_pool
 * (Pinnacle has ZERO pack_drop_pool rows), so neither basis label applies and
 * claiming one would be a new false statement.
 */
export function packEvBasis(collectionSlug: string | null | undefined): PackEvBasisInfo | null {
  if (!collectionSlug) return null
  return PACK_EV_BASIS_BY_SLUG[collectionSlug] ?? null
}
