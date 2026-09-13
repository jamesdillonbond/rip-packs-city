import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // ⚠ PIN supabase-js TO THE ROOT COPY. Two worker directories
      // ⤵ 22 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §1 — read them before changing the next key.
      "@supabase/supabase-js": path.resolve(
        __dirname,
        "node_modules/@supabase/supabase-js",
      ),
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    environment: "node",
    // ── testTimeout: 30s, raised from vitest's 5s DEFAULT (2026-08-24) ────────
    // ⤵ 24 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §2 — read them before changing the next key.
    testTimeout: 30_000,
    // ── hookTimeout: 30s, raised from vitest's 10s DEFAULT (2026-09-12) ────────
    // ⚠ THE 2026-08-24 testTimeout FIX WAS INCOMPLETE IN EXACTLY THE WAY THAT
    // KEPT ITS OWN NAMED EXAMPLE FLAKY. §2 above lists
    // `api-allday-listings-indexer` among the files that red for being SLOW and
    // pass in isolation — and on 2026-09-12 it redded again, on an IDLE box in a
    // 161 s run, with `Hook timed out in 10000ms` and the file at 16,396 ms.
    // testTimeout does NOT apply to beforeAll/beforeEach; hooks kept the 10s
    // default, so a heavy `vi.resetModules()` + `await import("@/app/api/...")`
    // in a beforeAll was still racing a limit the rest of the suite had left.
    //
    // 🚨 AND THE COST IS THE ONE §2 PREDICTED: it reports as a HOOK failure with
    // ZERO failed assertions and the block's tests marked skipped, which reads as
    // structural breakage rather than slowness. It cost a wrong diagnosis here —
    // a cross-file env leak was identified, hardened, and had to be retracted
    // when the control showed a reverted suite passing too.
    //
    // Same trade as testTimeout, stated: a genuinely hung hook now takes 30s to
    // fail instead of 10.
    hookTimeout: 30_000,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      // ⚠ DISTINCT PER GATE, AND LOAD-BEARING. All three gates defaulted to
      // ⤵ 24 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §3 — read them before changing the next key.
      reportsDirectory: "coverage",
      reporter: ["text", "html"],
      // Two tested layers are measured here: the pure lib/ logic (unit tests)
      // ⤵ 52 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §4 — read them before changing the next key.
      include: [
        "lib/**/*.ts",
        "lib/**/*.tsx",
        "app/**/route.ts",
        "app/**/route.tsx",
        "supabase/functions/_shared/**/*.ts",
        "proxy.ts",
      ],
      exclude: ["lib/**/*.test.ts", "lib/**/*.d.ts"],
      // ⚠ WHAT NO GATE MEASURES, written here because an audit has now
      // rediscovered it twice (2026-08-29 and 2026-09-12) and both times it
      // read as an oversight. Measured 2026-09-12: **341 of 1,460** source
      // files are matched by NO gate's include —
      //   116  app/**/page.tsx        server pages: product surfaces
      //   105  scripts/**             dev tooling; 93 test files DO import it
      //    63  app/**/layout.tsx      product surfaces
      //    38  supabase/functions/*   38 of 38 use Deno.*/serve() — vitest
      //                               CANNOT import them; not achievable here
      // ⛔ UNMEASURED, NOT UNTESTED — tests exist; no number says how much runs.
      // ⛔ Deliberately NOT ratcheted: a ceiling over high-churn scripts/ or over
      // 116 pages reds on routine work, which is the permanently-red-arm
      // failure. Whether to gate a named subset instead is an OPEN decision, not
      // an oversight: docs/overnight/inbox/2026-09-13T0108Z-341-source-files-
      // sit-in-no-coverage-gate-and-nothing-watched-the-denominator.md
      // ⚠ The SHRINKING direction IS guarded —
      // __tests__/coverage-gates-still-measure-what-they-claim.test.ts bans any
      // lib/ module, app/**/route.ts, worker or *Client.tsx falling out of a
      // gate, because narrowing an include RAISES the percentage.
      // CI ratchet — set just below the current baseline so a coverage DROP
      // ⤵ 751 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §5 — read them before changing the next key.
      thresholds: {
        statements: 91.8,
        branches: 79.4,
        functions: 93.6,
        lines: 93.85,
      },
    },
  },
})
