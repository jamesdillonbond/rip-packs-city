import { defineConfig } from "vitest/config"
import path from "path"

// SECOND coverage gate — React components / client pages.
// ⤵ 11 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §6 — read them before changing the next key.
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
    // ── testTimeout: 30s, raised from vitest's 5s DEFAULT (2026-08-24) ────────
    // ⤵ 24 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §7 — read them before changing the next key.
    testTimeout: 30_000,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      // ⚠ DISTINCT PER GATE, AND LOAD-BEARING. All three gates defaulted to
      // ⤵ 24 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §8 — read them before changing the next key.
      reportsDirectory: "coverage-components",
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
        // Added 2026-09-04 with its first component. `components/media/IpfsImg`
        // carries the one-shot retry for /api/public/ipfs-media cold-cache 502s
        // (12 of 15 images blank on /nba-top-shot/market, measured live), and it
        // ships WITH tests — so it joins the gate rather than the unmeasured
        // allowlist. The rot-guard is what caught the omission.
        "components/media/**/*.tsx",
        // Added 2026-09-06 with its first component: `components/telemetry/
        // ClientErrorBeacon` is the ONLY client-side error detector (#34) and
        // ships with tests that prove a thrown error becomes one bounded beacon.
        "components/telemetry/**/*.tsx",
        "components/sniper/**/*.tsx",
        "components/collection/**/*.tsx",
        "components/pinnacle/**/*.tsx",
        "components/alerts/**/*.tsx",
        "components/fast-break/**/*.tsx",
        "components/rtr/**/*.tsx",
        "components/insights/**/*.tsx",
        // Added 2026-07-31 (test-coverage pass): three previously-UNMEASURED
        // ⤵ 8 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §9 — read them before changing the next key.
        "components/auth/**/*.tsx",
        "components/marketplace-status/**/*.tsx",
        "components/onboarding/**/*.tsx",
        // Added 2026-08-01 (KNOWN_UNMEASURED audit): two subtrees that had been
        // allowlisted with inaccurate "presentational" reasons but carry real
        // branch logic. pricing = StripeSubscribeButton's fetch state machine
        // (401→login redirect / url→checkout / !ok error / thrown-fetch error) —
        // the only paid-conversion path, NOT "static marketing". filters =
        // LeagueFilter's visible gate + active-toggle + fire-only-on-change.
        "components/pricing/**/*.tsx",
        "components/filters/**/*.tsx",
        // Added 2026-08-11: the global catalog search bar. Logic-bearing on
        // arrival — a debounced fetch with out-of-order response rejection, a
        // 4-state status machine whose error state must stay DISTINCT from
        // "no results", and keyboard listbox navigation.
        "components/search/**/*.tsx",
        // ── 2026-08-20: the LAST four subtrees, so `components/` is now whole ──
        // ⤵ 34 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §10 — read them before changing the next key.
        "components/legal/**/*.tsx",
        "components/play/**/*.tsx",
        "components/ui/**/*.tsx",
        "components/visual/**/*.tsx",
        // app/insights/**/*Client.tsx — the public /insights board CLIENT bodies
        // ⤵ 23 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §11 — read them before changing the next key.
        "app/**/*Client.tsx",
        "app/insights/squeeze-check/page.tsx",
        "app/insights/tc-report/page.tsx",
        "app/insights/pack-reality/page.tsx",
      ],
      exclude: ["**/*.test.tsx", "**/*.d.ts"],
      // Component ratchet — set just below the live baseline so a DROP fails CI
      // ⤵ 519 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §12 — read them before changing the next key.
      thresholds: {
        statements: 90.85,
        branches: 81.95,
        functions: 89.3,
        lines: 93.75,
      },
    },
  },
})
