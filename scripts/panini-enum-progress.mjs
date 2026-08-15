// Panini grid-enumeration progress signal — extracted from ingest-panini-runner.mjs so the
// stop decision is unit-testable without launching a browser (the runner calls main() at import).
//
// WHY THIS EXISTS (2026-08-15). The runner scrolls the marketplace grid to enumerate WC-Prizm
// pskus, and stopped after N consecutive scroll iterations that added no NEW WC psku. But the
// grid it scrolls is filtered ONLY by sport=Soccer — confirmed live, the products op sends
// applied_filters:"marketplace-nfts?sport=Soccer&p=N" — and that grid mixes >=5 products
// (page 1 measured 13 of 27 pskus in the WC setId 2332, ~48%). So the stability heuristic was
// evaluated against a stream that is roughly half noise, and a run of non-WC pages ended the
// enumeration while the server was still serving full pages.
//
// The evidence that this was premature termination rather than exhausted inventory: across 5
// consecutive walks the grid returned pages 1..N sequentially, EVERY page exactly 30 items —
// never a short final page — and the walk quit at 41, 11, 12, 18 and 15 pages. Genuine
// exhaustion stops at a repeatable depth and ends on a partial page.
//
// THE FIX: count progress as (WC pskus found + ALL products the grid has served). A stretch of
// non-WC soccer still advances the signal, so dilution cannot end the walk; a genuinely
// exhausted grid stops advancing both terms and the walk ends exactly as it did before.

/**
 * Composite enumeration progress. Monotonic non-decreasing across a walk.
 * @param {number} wcPskus  distinct WC-Prizm pskus discovered so far
 * @param {number} gridItems total products the grid has returned so far (ALL sports/sets)
 */
export function enumProgress(wcPskus, gridItems) {
  return wcPskus + gridItems;
}

/**
 * Fold one scroll iteration into the stability state.
 * `stable` counts CONSECUTIVE iterations with no progress; any progress resets it to 0.
 * @returns {{last:number, stable:number}}
 */
export function stepStability(prev, progress) {
  if (progress === prev.last) return { last: prev.last, stable: prev.stable + 1 };
  return { last: progress, stable: 0 };
}

/**
 * Classify why enumeration ended. Order matters: a budget break exits with stable below the
 * threshold, so budget must be tested before the stable condition.
 */
export function enumStopReason({ budgetHit, stable, stableThreshold }) {
  if (budgetHit) return "budget";
  if (stable >= stableThreshold) return "stable";
  return "max_iters";
}
