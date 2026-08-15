import { describe, it, expect } from "vitest";
// Plain .mjs helper shared with the standalone Panini runner. No `@ts-expect-error` is needed and
// adding one FAILS the build: tsconfig sets `allowJs` with `checkJs` off, so TS resolves this
// module and infers its signatures from JSDoc, which makes a suppression here an unused directive
// (TS2578) — an error under the blocking `typecheck` CI job.
import { enumProgress, stepStability, enumStopReason } from "../scripts/panini-enum-progress.mjs";

/**
 * Guards the Panini grid-enumeration stop decision.
 *
 * THE DEFECT THIS PINS (2026-08-15): the runner stopped scrolling the marketplace grid after 5
 * consecutive iterations that added no new WC-Prizm psku. The grid it scrolls is filtered ONLY by
 * sport=Soccer and mixes >=5 products (~48% WC on page 1), so a run of non-WC pages ended the
 * enumeration while the server was still serving full 30-item pages. Measured effect: editions
 * priced/day fell ~800 -> 153 while per-batch capture was completely unchanged (2.16-3.11
 * editions/batch, zero failed batches) — i.e. the runner was healthy per unit of work and was
 * simply being handed less work.
 *
 * The proof it was premature termination and not exhausted inventory: 5 consecutive walks fetched
 * pages 1..N sequentially, EVERY page exactly 30 items, quitting at 41 / 11 / 12 / 18 / 15 pages.
 * Real exhaustion stops at a repeatable depth and ends on a short page.
 */

const STABLE_THRESHOLD = 8;

/**
 * Replays a walk against a synthetic grid and returns how many pages were consumed.
 * `wcPerPage[i]` = how many NEW WC pskus page i contributes; every page serves 30 products,
 * which is what the live capture shows.
 *
 * `mode: "wc-only"` reproduces the OLD signal (WC pskus only).
 * `mode: "composite"` is the shipped signal (WC pskus + all grid items).
 */
function runWalk(wcPerPage: number[], mode: "wc-only" | "composite", stableThreshold = STABLE_THRESHOLD) {
  let wc = 0;
  let gridItems = 0;
  let state = { last: -1, stable: 0 };
  let pagesConsumed = 0;

  for (let i = 0; i < wcPerPage.length && state.stable < stableThreshold; i++) {
    wc += wcPerPage[i];
    gridItems += 30; // every page serves exactly 30 products (verified live across 98 responses)
    pagesConsumed++;
    const progress = mode === "composite" ? enumProgress(wc, gridItems) : wc;
    state = stepStability(state, progress);
  }
  return { pagesConsumed, wc, stable: state.stable };
}

describe("panini enumeration progress signal", () => {
  it("composite progress advances on a non-WC page; WC-only progress does not", () => {
    // One page of pure non-WC soccer product.
    expect(enumProgress(10, 30)).toBe(40);
    expect(enumProgress(10, 60)).toBe(70); // advanced purely on grid items
    // The old signal is blind to it: same WC count => identical value => counted as "no progress".
    expect(stepStability({ last: 10, stable: 0 }, 10).stable).toBe(1);
    // The composite signal registers the page and resets the stall counter.
    expect(stepStability({ last: 40, stable: 3 }, 70).stable).toBe(0);
  });

  it("THE REGRESSION: a dilute stretch stops the old signal early but not the shipped one", () => {
    // 40 pages of real inventory, where WC cards arrive in clumps and there is a 9-page stretch
    // of other soccer product in the middle — exactly the shape that produced the 11/12/15/18-page
    // walks against a grid still serving full pages.
    const grid = [
      ...Array(10).fill(14), // pages 1-10: WC-dense (~48%, matching the page-1 measurement)
      ...Array(9).fill(0), //  pages 11-19: other soccer product only
      ...Array(21).fill(12), // pages 20-40: WC inventory the walk never reached
    ];

    const oldWalk = runWalk(grid, "wc-only", 5); // the shipped-before threshold was 5
    const newWalk = runWalk(grid, "composite");

    // Old: dies inside the dilute stretch, having seen only the first clump.
    expect(oldWalk.pagesConsumed).toBe(15);
    expect(oldWalk.wc).toBe(140);

    // New: walks the whole grid and finds the inventory beyond the stretch.
    expect(newWalk.pagesConsumed).toBe(40);
    expect(newWalk.wc).toBe(392);

    // The point of the fix, stated as a ratio so a future weakening is obvious.
    expect(newWalk.wc / oldWalk.wc).toBeGreaterThan(2.5);
  });

  it("still stops on a genuinely exhausted grid — the fix must not make walks unbounded", () => {
    // A grid that runs out: no further pages are served at all, so neither term advances.
    // Simulated as trailing pages contributing no WC cards AND no grid items.
    let wc = 120;
    let gridItems = 300;
    let state = { last: enumProgress(wc, gridItems), stable: 0 };
    let iters = 0;
    for (let i = 0; i < 200 && state.stable < STABLE_THRESHOLD; i++) {
      iters++;
      // exhausted: nothing new arrives on either term
      state = stepStability(state, enumProgress(wc, gridItems));
    }
    expect(state.stable).toBe(STABLE_THRESHOLD);
    expect(iters).toBe(STABLE_THRESHOLD); // terminates promptly, no runaway
  });

  it("classifies the stop reason, and budget wins over an unmet stable threshold", () => {
    // A budget break exits with `stable` below threshold — if the stable test came first this
    // would misreport as "max_iters" and hide that enumeration was cut short by its own clock.
    expect(enumStopReason({ budgetHit: true, stable: 2, stableThreshold: 8 })).toBe("budget");
    expect(enumStopReason({ budgetHit: false, stable: 8, stableThreshold: 8 })).toBe("stable");
    expect(enumStopReason({ budgetHit: false, stable: 3, stableThreshold: 8 })).toBe("max_iters");
    // Budget must win even when the stable threshold is also satisfied.
    expect(enumStopReason({ budgetHit: true, stable: 8, stableThreshold: 8 })).toBe("budget");
  });
});
