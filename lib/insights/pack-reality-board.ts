// lib/insights/pack-reality-board.ts
//
// The PACK REALITY board behind /insights/allday-pack-reality — "the model says
// $X, packs actually pull $Y."
//
// ⚠ WHY THIS IS WORTH EXTRACTING. This is an honesty board about OUR OWN pack-EV
// model, and every threshold below decides which distributions a collector is
// shown as evidence that the model is wrong. It lived in a `page.tsx`, which
// neither coverage gate measures — ten derivation sites (filters, sorts, slices,
// threshold comparisons) with no test at all, on a PUBLIC surface.
//
// ⚠ THE THREE BUCKETS ARE NOT SYMMETRIC, AND THE ASYMMETRIES ARE DELIBERATE.
// Reading them as an oversight is the mistake to avoid:
//   • `over` (the model OVER-values: packs pulled far less than modeled) also
//     requires `nonFossil`. `under` and `onModel` do NOT.
//   • `over` requires a modeled EV of at least $2; `under` only $0.50.
//   • `onModel` is ranked by SAMPLE SIZE, not by ratio — a band has no "most"
//     end to sort toward, so the most-opened distributions lead as the best
//     evidence.
// Each is explained at its constant.

import { supabaseAdmin } from "@/lib/supabase"
import { fetchAllPaged } from "@/lib/supabase-paginate"
import { withPagedBoardBudget } from "@/lib/insights/board-page-fetch"

/** Minimum opened packs for a distribution's realized pull value to mean anything. */
export const MIN_OPENS = 5

/**
 * ⚠ THE FOSSIL GUARD. A distribution whose MODELED EV sits above 1.5× its pack
 * price is almost always a depleted pool: CLAUDE.md records that a drained Top
 * Shot pool prices at 40–86×, because once the good moments are pulled the
 * modeled average is computed over a tail that nobody can actually pull.
 *
 * ⚠ It is applied to `over` ONLY, and that is the point. `over` is the list of
 * distributions where the model wildly OVER-promised — exactly what a fossil
 * looks like by construction, so without this guard the "model over-values"
 * board would be nothing but depleted pools, and the real over-valuations would
 * be pushed off it. For `under` (packs pulled MORE than modeled) a fossil is not
 * a plausible member at all, so guarding it there would exclude nothing while
 * implying the two lists are filtered alike.
 */
export const FOSSIL_EV_TO_PRICE_MAX = 1.5

/** Below this realized-to-modeled ratio, the model OVER-valued the pack. */
export const OVER_MAX_RATIO = 0.6
/** Above this realized-to-modeled ratio, the model UNDER-valued the pack. */
export const UNDER_MIN_RATIO = 1.8
/** Inclusive band treated as the model being broadly right. */
export const ON_MODEL_MIN_RATIO = 0.8
export const ON_MODEL_MAX_RATIO = 1.25

/**
 * ⚠ ASYMMETRIC EV FLOORS, deliberately. A ratio is a RATIO: on a pack modeled at
 * $0.30, a realized $0.10 is a 0.33 ratio and reads as a dramatic
 * over-valuation while being twenty cents. The `over` list is the accusatory one
 * — it says our model was wrong — so it carries the higher bar. `under` costs a
 * collector nothing to read, so it admits smaller packs.
 */
export const OVER_MIN_MODELED_EV = 2
export const UNDER_MIN_MODELED_EV = 0.5

/** Rows shown in each bucket. */
export const RANK_LIMIT = 12

export interface PackRealityRow {
  dist_id: string
  title: string | null
  pack_price: number | string | null
  modeled_gross_ev: number | string | null
  ev_method: string | null
  n_opens: number | string | null
  n_valued: number | string | null
  realized_mean: number | string | null
  realized_median: number | string | null
  realized_to_modeled_ratio: number | string | null
}

export interface PackRealityBuckets {
  /**
   * ⚠ false when the backing read FAILED — distinct from "no qualifying packs
   * yet". This board's empty state is a real and common answer (the view is
   * sparse until paid distributions clear the open threshold), which is exactly
   * why the two must not collapse: "we are still gathering" and "we could not
   * read" look identical on screen otherwise.
   */
  ok: boolean
  over: PackRealityRow[]
  under: PackRealityRow[]
  onModel: PackRealityRow[]
  qualifying: number
  fetchedAt: string
}

export function num(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Rank realized-vs-modeled rows into over / under / on-model.
 *
 * Pure over the fetched rows, so every threshold is testable without a database.
 * `fetchedAt` is passed in rather than read from the clock here — a pure
 * function that calls `new Date()` is not pure, and the page needs the stamp to
 * describe the READ, not the ranking.
 */
export function bucketPackRealityRows(
  rows: PackRealityRow[],
): Omit<PackRealityBuckets, "ok" | "fetchedAt"> {
  const priced = rows.filter(
    (r) => (num(r.pack_price) ?? 0) > 0 && num(r.modeled_gross_ev) != null,
  )
  const ratio = (r: PackRealityRow) => num(r.realized_to_modeled_ratio)
  const nonFossil = (r: PackRealityRow) => {
    const ev = num(r.modeled_gross_ev)
    const price = num(r.pack_price)
    return ev != null && price != null && ev <= price * FOSSIL_EV_TO_PRICE_MAX
  }
  const over = priced
    .filter(
      (r) =>
        nonFossil(r) &&
        (ratio(r) ?? 99) < OVER_MAX_RATIO &&
        (num(r.modeled_gross_ev) ?? 0) >= OVER_MIN_MODELED_EV,
    )
    .sort((a, b) => (ratio(a) ?? 99) - (ratio(b) ?? 99))
    .slice(0, RANK_LIMIT)
  const under = priced
    .filter(
      (r) =>
        (ratio(r) ?? 0) > UNDER_MIN_RATIO &&
        (num(r.modeled_gross_ev) ?? 0) >= UNDER_MIN_MODELED_EV,
    )
    .sort((a, b) => (ratio(b) ?? 0) - (ratio(a) ?? 0))
    .slice(0, RANK_LIMIT)
  const onModel = priced
    .filter((r) => (ratio(r) ?? 0) >= ON_MODEL_MIN_RATIO && (ratio(r) ?? 0) <= ON_MODEL_MAX_RATIO)
    // ⚠ Ranked by SAMPLE SIZE, not ratio: a band has no "most" end to sort
    // toward, so the most-opened distributions lead as the strongest evidence
    // that the model is right.
    .sort((a, b) => (num(b.n_opens) ?? 0) - (num(a.n_opens) ?? 0))
    .slice(0, RANK_LIMIT)
  return { over, under, onModel, qualifying: priced.length }
}

/**
 * Fetch and rank the All Day pack-reality board.
 *
 * The client is DEFAULTED rather than passed by the caller so the page can drop
 * its `@/lib/supabase` import — the property the server-page data-access ratchet
 * keys on. Tests inject `db`.
 */
export async function fetchPackRealityBuckets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<PackRealityBuckets> {
  const { rows: data, error } = await withPagedBoardBudget(
    fetchAllPaged<PackRealityRow>(
      (from, to) =>
        db
          .from("v_allday_pack_realized_ev")
          .select(
            "dist_id, title, pack_price, modeled_gross_ev, ev_method, n_opens, n_valued, realized_mean, realized_median, realized_to_modeled_ratio",
          )
          .gte("n_opens", MIN_OPENS)
          .eq("low_confidence_ev", false)
          // ⚠ The `priced` filter is pushed into SQL as well as applied in JS.
          // This view costs ~26s (it aggregates 2.8M pack_rips rows), so paging
          // it is far more expensive than the sibling boards — filtering here
          // cut 1,559 rows to 302, one page instead of two. The JS filter is
          // identical, so the rendered result is unchanged; it stays because the
          // ranking must not depend on the SQL having been written correctly.
          .gt("pack_price", 0)
          .not("modeled_gross_ev", "is", null)
          .order("dist_id", { ascending: true })
          .range(from, to),
      { label: "insights/allday-pack-reality" },
    ),
    "allday-pack-reality",
  )
  const fetchedAt = new Date().toISOString()
  if (error) {
    console.error("[insights/allday-pack-reality] realized", error)
    return { over: [], under: [], onModel: [], qualifying: 0, fetchedAt, ok: false }
  }
  return { ...bucketPackRealityRows((data ?? []) as PackRealityRow[]), fetchedAt, ok: true }
}
