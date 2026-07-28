import { defineConfig } from "vitest/config"
import path from "path"

// SECOND coverage gate — React components / client pages.
//
// The primary vitest.config.ts measures ONLY lib/** + app/api/**/route.ts, so
// the ~429 component/page .tsx files contribute nothing to that ratchet and
// their coverage could silently rot (or new untested financial UI could land)
// with nothing to catch it. This config gates the component layer separately,
// at its own (lower) threshold, so component coverage can only go UP.
//
// It runs the SAME jsdom-tagged suites (__tests__/**/*.test.tsx) the main run
// already executes, but scopes the coverage `include` to the component tree.
// CI job `component-tests` runs `npm run test:coverage:components`.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    // Only the component/hook suites (they self-declare `// @vitest-environment
    // jsdom`); the node-env route/lib suites stay in the primary config.
    include: ["__tests__/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Scoped to the subtrees where LOGIC-bearing components concentrate
      // (financial display, sort/filter, data shaping) — the ones worth a gate.
      // A whole-tree include drowns the signal in ~370 presentational files and
      // pins the number near 5%. Add a subtree here as its components gain tests.
      include: [
        "components/*.tsx",
        "components/analytics/**/*.tsx",
        "components/profile/**/*.tsx",
        "components/packs/**/*.tsx",
        "components/entity/**/*.tsx",
        "components/sniper/**/*.tsx",
        "components/collection/**/*.tsx",
        "components/pinnacle/**/*.tsx",
        "components/alerts/**/*.tsx",
        "components/fast-break/**/*.tsx",
        "components/rtr/**/*.tsx",
        "components/insights/**/*.tsx",
      ],
      exclude: ["**/*.test.tsx", "**/*.d.ts"],
      // Component ratchet — set just below the live baseline so a DROP fails CI
      // while normal noise passes. Raise as component coverage climbs; never
      // lower to make a red build pass. Keep a ~0.3 buffer under actual for
      // concurrent churn (component tests are lighter than the route suites, so
      // one new untested component moves this more than it moves the primary
      // ratchet).
      //   2026-07-26 (initial gate): scoped baseline was 18.1/15.5/17.3/18.9;
      //     adding tests for the 4 financial components (CrossCollectionPortfolio,
      //     PinnacleFmvChart, PackMarketView, InsiderSignalsPanel) lifted it to
      //     live actual 20.65 stmts / 17.33 branch / 19.39 funcs / 21.55 lines
      //     (311 component/hook tests). Thresholds set ~0.5 under actual.
      //   2026-07-26 (cont.): +PinnacleListingCard -> live actual 20.76 / 17.53 /
      //     19.46 / 21.69. Thresholds nudged up, ~0.5 buffer kept.
      //   2026-07-26 (cont. — top-level component pure helpers): tested the pure
      //     exports of two top-level components — MomentMedia getImageUrl/
      //     getVideoUrl (the bare-IPFS-gateway guard that stops broken Series-1/UFC
      //     art) and BadgeRow normalizeBadges (4-source dedup). All-files
      //     22.80 -> live actual 23.61 st / 20.36 br / 21.89 fn / 24.72 ln.
      //     Thresholds bumped ~0.4 under.
      //   2026-07-26 (test-coverage-analysis pass — 3 new subtrees added to the
      //     include so they can no longer rot: components/alerts, components/
      //     fast-break, components/rtr, previously UNMEASURED). Covered
      //     WatchEditionButton (alerts, 97.8% st — collapsed/open form, the
      //     positive-threshold guard, 200/401/500/network legs, the never-send-
      //     owner_key contract, telegram note), SlateRow (fast-break, live/final/
      //     scheduled badges + TBD + local↔ET flip), FastBreakClient (63.5% —
      //     optimize/uses render via a keyed useWarmCache mock), and RTRClient
      //     (47.3% — Tonight's Pick loading/empty/no_fresh_odds/live-pick + tier +
      //     lock-roi). Subdir coverage: alerts 97.8 / fast-break 63.5 / rtr 47.3.
      //     Live actual (All files): 22.80 stmts / 19.58 branch / 21.56 funcs /
      //     23.86 lines. Thresholds bumped ~0.4 under actual for concurrent churn.
      //   2026-07-28 (test-coverage-analysis "all of them" Gap D — the two biggest
      //     untested logic-bearing components): CollectionMomentTable (the
      //     ~850-line wallet moment table, 0 -> 46% st — mobile/desktop/expanded
      //     panel, tier chip, All Day lock-untracked, three-star rookie badge
      //     suppression, cost-basis, empty + null-name states) and TopBuyers (the
      //     Top Accumulators leaderboard, fetch → skeleton → $k/$M fmt + username
      //     resolve + empty/non-ok/reject legs). Live actual (All files): 26.56
      //     stmts / 23.68 branch / 25.42 funcs / 27.81 lines. Thresholds bumped
      //     ~0.3 under actual.
      //   2026-07-28 (monolith Phase-2 slice #5 — CollectionRecentSales extracted
      //     from the WalletMomentsBody monolith with its own 8-test suite). Live
      //     actual 26.87 stmts / 24.01 branch / 25.81 funcs / 28.07 lines.
      //     Thresholds bumped ~0.3 under actual.
      //   2026-07-28 (Gap D+ — WalletProfile, the ~1,000-line lending wallet card,
      //     0 -> 70% st / 52% br: role classification Borrower/Lender/Mixed, limbo
      //     rollups, counterparty extraction incl. position transfers, username-vs-
      //     address header, empty-history). Live actual (All files): 28.94 stmts /
      //     26.22 branch / 27.11 funcs / 30.11 lines. Bumped ~0.3 under actual.
      //   2026-07-28 (Gap D++ — PositionTransfersCard, the collapsible loan
      //     position-transfers analytics card, 0 -> covered: fetch-on-open,
      //     KPI money/number/pct formatting, wallet tables, could-not-load
      //     fallback, fetch cache). Live actual (All files): 30.17 stmts / 27.29
      //     branch / 28.34 funcs / 31.29 lines. Bumped ~0.3 under actual.
      //   2026-07-28 (test-coverage-analysis "all of them" #3 — added the
      //     components/insights subtree to the gate (previously UNMEASURED; it
      //     could silently rot) and covered its lead-capture band
      //     InsightsEmailCapture (validation gate → no-network, POST payload
      //     contract, sent/server-error/success:false/network terminal states)
      //     plus entity/FmvHistoryChart (exported fmtUsd/fmtDay money+date
      //     formatters — the silent-$0 axis/tooltip class — and the <=2-point
      //     "too few sales" empty state + the 90d re-fetch degrading to [] on a
      //     500). The two new tests net-raised the aggregate despite the 3
      //     still-untested insights files the subtree pulled in. Live actual
      //     (All files): 31.31 stmts / 27.97 branch / 29.56 funcs / 32.42 lines.
      //     Bumped ~0.3 under actual.
      //   2026-07-28 (cont. — "keep going"): covered analytics/NetMarketplace
      //     Leaderboard (the Flowty net buy/sell leaderboard: fmtUsd $M/$k/$/cents
      //     banding + the net-seller-green / net-buyer-red / flat-muted coloring
      //     that IS the table's meaning, + the day/collection re-fetch legs and
      //     the non-ok fetch degrade). Live actual (All files): 32.14 stmts /
      //     28.66 branch / 30.53 funcs / 33.21 lines. Bumped ~0.3 under.
      thresholds: {
        statements: 31.8,
        branches: 28.3,
        functions: 30.2,
        lines: 32.9,
      },
    },
  },
})
