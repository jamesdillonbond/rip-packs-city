// lib/set-completion-tier.ts
//
// THE single source of truth for how a set-completion progress row is bucketed
// into a display tier.
//
// WHY THIS EXISTS
// ---------------
// Until 2026-08-01 this classification was duplicated FIVE times with FOUR
// different "almost there" thresholds, so the same set was described
// differently depending on which surface you happened to be looking at:
//
//   app/api/sets/route.ts              missingPlays === 1 || === 2
//   app/api/allday-set-progress/route  missingPlays <= 3 && hasCost
//   app/api/ufc-set-progress/route     missingPlays <= 3 && hasCost  (byte-identical)
//   app/api/allday-sets/route.ts       missingCount <= 3 && allPriced
//   app/api/sets-db/route.ts           completionPct >= 80  (progress only)
//
// Consequence: a set missing exactly 3 pieces read "almost there" on four
// surfaces but not on /api/sets; an 85%-complete set missing 8 pieces read
// "almost there" only on /api/sets-db.
//
// THE CHOSEN THRESHOLD IS A PRODUCT DECISION.
// ALMOST_THERE_MAX_MISSING = 3 was picked because it was already what THREE of
// the five surfaces used (allday-set-progress, ufc-set-progress, allday-sets),
// so unifying on it changes the fewest surfaces. It is deliberately a named
// constant so it can be retuned in exactly one place. Trevor may well want a
// different number, or a rule that scales with set size (missing <= 10% of a
// 60-card set is a very different ask from 3 of 5) - that is a judgement call
// about what "almost there" should MEAN, not a bug, and it is not being made
// here.
//
// The one caller that legitimately cannot use the cost-aware ladder is
// /api/sets-db, which has no ask/price pipeline at all. Rather than force it
// to report every unfinished set as "unpriced" (which would hide real
// progress - the exact regression its own comment warns about, Set audit B6),
// pass `pricingAvailable: false` and it classifies on progress alone. That
// arm still lives HERE so the vocabulary and both thresholds stay in one file.

export type SetTier =
  | "complete"
  | "almost_there"
  | "bottleneck"
  | "completable"
  | "incomplete"
  | "unpriced";

/**
 * How many missing pieces still counts as "almost there", for callers that
 * have a real price signal. See the product-decision note above.
 */
export const ALMOST_THERE_MAX_MISSING = 3;

/**
 * Progress-only fallback threshold, used ONLY when `pricingAvailable` is
 * false. Preserves the pre-existing /api/sets-db behaviour.
 */
export const PROGRESS_ALMOST_THERE_PCT = 80;

export interface SetCompletionInput {
  /** 0-100. >= 100 is complete. */
  completionPct: number;
  /** Number of pieces still needed. */
  missingCount: number;
  /**
   * Cost to finish the set. null or <= 0 means "no usable price signal",
   * NOT "free".
   */
  estimatedCost?: number | null;
  /**
   * True only when EVERY missing piece carries a live ask. When supplied it
   * takes precedence over `estimatedCost` for the "is this actionable?" test,
   * because a partial cost total understates the real bill.
   */
  allPriced?: boolean;
  /**
   * False when the ask-enrichment step did not run for this set at all
   * (distinct from "ran and found nothing").
   */
  asksEnriched?: boolean;
  /** True when the caller detected a single dominant blocking piece. */
  hasBottleneck?: boolean;
  /**
   * False for callers with no pricing pipeline whatsoever (/api/sets-db).
   * Switches to the progress-only ladder.
   */
  pricingAvailable?: boolean;
}

export function classifySetTier(i: SetCompletionInput): SetTier {
  const { completionPct, missingCount } = i;

  // 1. Finished. Keyed on completionPct ONLY - every one of the five original
  //    implementations did the same. Deliberately NOT `missingCount <= 0`:
  //    an empty / zero-edition set has 0 missing pieces but 0% completion and
  //    must not be reported as "complete" (see step 3).
  if (completionPct >= 100) return "complete";

  // 2. Callers with no pricing pipeline at all classify on progress.
  if (i.pricingAvailable === false) {
    if (completionPct >= PROGRESS_ALMOST_THERE_PCT) return "almost_there";
    if (completionPct > 0) return "incomplete";
    return "unpriced";
  }

  // 3. Nothing missing, yet not at 100% -> an empty / zero-edition set (or a
  //    set whose checklist has not been indexed). "incomplete" is the honest
  //    bucket; "complete" would claim a finished set that does not exist.
  if (missingCount <= 0) return "incomplete";

  // 3b. ZERO PROGRESS is never "almost there". Owning 0 pieces of a 3-piece set
  //     satisfies `missingCount <= 3` and, with a price, would otherwise be
  //     promoted to "almost_there" - telling a user who owns NOTHING that they
  //     are nearly done.
  //     allday-set-progress and ufc-set-progress both guarded this explicitly
  //     (`if (completionPct === 0) return "incomplete"`); /api/sets and
  //     allday-sets did not. Unifying without this guard would have silently
  //     REGRESSED the two surfaces that had it, so it is preserved here for all
  //     callers rather than dropped as an accident of whichever ladder won.
  if (completionPct <= 0) return "incomplete";

  // 4. Enrichment never ran -> we know nothing about cost.
  if (i.asksEnriched === false) return "unpriced";

  const cost = i.estimatedCost ?? null;
  const hasCost = cost !== null && cost > 0;
  // `allPriced` wins when supplied; otherwise a positive cost is our proxy.
  const actionable = i.allPriced ?? hasCost;

  if (!actionable && !hasCost) return "unpriced";

  // 5. Within touching distance AND actually buyable.
  if (missingCount <= ALMOST_THERE_MAX_MISSING && actionable) return "almost_there";

  // 6. One dominant piece is holding the set hostage.
  if (i.hasBottleneck) return "bottleneck";

  // 7. Priced, but a real shopping list.
  if (hasCost) return "completable";

  return "incomplete";
}
