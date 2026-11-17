// Pack-EV row derivation — the arithmetic behind the PUBLIC +EV badge.
//
// WHY THIS MODULE EXISTS. `compute-topshot-pack-ev/index.ts` is 1,583 lines, the largest
// single file in `supabase/functions/**`, and it is measured by NO coverage gate: the
// primary gate stops at `app/**/route.ts` + `lib/**`, the component gate at
// `components/**` + `app/**/*Client.tsx`, and the worker gate at `workers/**`. Deno edge
// source is outside all three by construction. What that file computes is the badge a
// collector uses to decide whether to buy a pack, and the four expressions below are the
// whole of that decision.
//
// The DB side of pack EV is pinned in detail (`refresh_atlas_pack_ev`,
// `backfill_topshot_historical_pack_ev`): no +EV without a known ask, a NULL value_ratio
// rather than a fabricated one, a delisted or zero ask treated as NO ask. THIS is the
// edge-side twin of those rules, and it had nothing.
//
// ⚠ THIS IS A TESTED MIRROR, NOT THE DEPLOYED CODE PATH. The edge function still computes
// these values inline; changing it to import this module would require redeploying the
// pack-EV writer, which is a production change with no local way to verify it end to end.
// `__tests__/edge-pack-ev-row-source-drift.test.ts` holds the two in sync by asserting the
// inline expressions still match this implementation, the same arrangement the repo
// already uses for `computeDualPrice` (which lives here, in `lib/`, and inline in that
// same edge function, kept honest by the inline-copy drift guard).
// The ideal end state is the edge function importing this module. Until then the guard is
// what makes the mirror worth having.

export type PriceSource = "primary" | "secondary" | "min" | "none"

/** The pack-price resolution this derivation consumes (see `computeDualPrice`). */
export interface DualPriceLike {
  packPrice: number
  priceSource: PriceSource
}

export interface DerivedEvRow {
  /** Gross EV, clamped to the range `pack_ev_history` accepts. */
  gross_ev: number
  /** Median-pull ("Typical Pull") EV, clamped; null when the RPC could not produce one. */
  typical_ev: number | null
  /** Net EV against the pack price, clamped. */
  pack_ev: number
  /** The public badge. */
  is_positive_ev: boolean
  /** Gross EV as a multiple of the price paid — NULL when there is no price. */
  value_ratio: number | null
  /** How much of the print run has been opened, 0..100 — NULL when the total is unknown. */
  depletion_pct: number | null
}

/**
 * The clamp `pack_ev_history` requires.
 *
 * ⚠ It is NOT cosmetic. The `pack_ev_latest` view filters `BETWEEN -10000 AND 1000000`, so
 * a value outside the range does not render as a big number — the row falls out of the
 * view entirely and the pack silently disappears from every EV surface. Clamping keeps a
 * wrong-looking pack visible and inspectable instead of vanishing it.
 */
export function clampEv(v: number): number {
  return Math.max(-10000, Math.min(1000000, v))
}

/**
 * Derive the published EV fields for one pack.
 *
 * The rules, each of which is a claim made to a collector:
 *
 *  - **No +EV without a price.** `priceSource === "none"` means nothing is buyable — no
 *    primary supply and no secondary ask. A pack you cannot buy is not a good deal, and
 *    treating "no price" as a price of 0 would make every unbuyable pack infinitely +EV.
 *  - **The badge needs a STRICTLY positive edge.** Break-even is not +EV.
 *  - **`value_ratio` is NULL, never fabricated.** Dividing by a zero price would be
 *    undefined; publishing a large number instead is the manufactured-figure class.
 *  - **`depletion_pct` is NULL when the print run is unknown**, and clamped to 0..100 when
 *    it is, so a bad `total_unopened` cannot publish "-40% opened" or "180% opened".
 */
export function derivePackEvRow(args: {
  grossEv: number
  typicalPullEv: number | null
  dual: DualPriceLike
  totalPackCount: number
  totalUnopened: number
}): DerivedEvRow {
  const { grossEv, typicalPullEv, dual, totalPackCount, totalUnopened } = args

  const packEv = Math.round((grossEv - dual.packPrice) * 100) / 100
  const isPositiveEv = dual.priceSource !== "none" && packEv > 0
  const valueRatio =
    dual.packPrice > 0 ? Math.round((grossEv / dual.packPrice) * 1000) / 1000 : null

  const depletionPct =
    totalPackCount > 0
      ? Math.min(100, Math.max(0, Math.round(((totalPackCount - totalUnopened) / totalPackCount) * 100)))
      : null

  return {
    gross_ev: clampEv(grossEv),
    typical_ev: typicalPullEv != null ? clampEv(typicalPullEv) : null,
    pack_ev: clampEv(packEv),
    is_positive_ev: isPositiveEv,
    value_ratio: valueRatio,
    depletion_pct: depletionPct,
  }
}

/**
 * The sentinel row written when the drop pool is empty or unpriceable.
 *
 * ⚠ Its purpose is to stop `pack_ev_latest` being NULL for the dist_id, which is what
 * makes the targets view re-select the same pack on every cron tick forever. It must
 * therefore be UNAMBIGUOUS: a hard `is_positive_ev: false` and a NULL `value_ratio`, so a
 * sentinel can never be mistaken for a measured zero-EV pack. It still carries the
 * dual-price fields, because the live primary/secondary state IS known and is worth
 * showing even when EV is not.
 */
export function sentinelEvRow(): Pick<
  DerivedEvRow,
  "gross_ev" | "pack_ev" | "is_positive_ev" | "value_ratio"
> & { fmv_coverage_pct: null; edition_count: number; depletion_pct: number } {
  return {
    gross_ev: 0,
    pack_ev: 0,
    is_positive_ev: false,
    value_ratio: null,
    fmv_coverage_pct: null,
    edition_count: 0,
    // A pack with no pool left is fully depleted by definition, and 100 is a real
    // statement rather than the NULL that "unknown" would mean.
    depletion_pct: 100,
  }
}
