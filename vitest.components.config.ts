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
      thresholds: {
        statements: 20,
        branches: 16.8,
        functions: 18.8,
        lines: 21,
      },
    },
  },
})
