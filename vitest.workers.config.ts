import { defineConfig } from "vitest/config"
import path from "path"

// THIRD coverage gate — the Cloudflare Workers.
// ⤵ 36 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §13 — read them before changing the next key.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // ⚠ PIN supabase-js TO THE ROOT COPY. Two worker directories
      // ⤵ 22 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §14 — read them before changing the next key.
      "@supabase/supabase-js": path.resolve(
        __dirname,
        "node_modules/@supabase/supabase-js",
      ),
    },
  },
  test: {
    // Only the worker suites. They are node-env like the primary run, so they
    // also execute there; this config re-runs them purely to scope `coverage`.
    include: ["__tests__/worker-*.test.ts"],
    environment: "node",
    // ── testTimeout: 30s, raised from vitest's 5s DEFAULT (2026-08-24) ────────
    // ⤵ 24 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §15 — read them before changing the next key.
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
      // ⤵ 24 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §16 — read them before changing the next key.
      reportsDirectory: "coverage-workers",
      reporter: ["text", "html"],
      include: ["workers/**/*.ts", "workers/**/*.js"],
      exclude: [
        // Wrangler config / type shims carry no logic.
        "workers/**/*.d.ts",
        "workers/**/node_modules/**",
      ],
      // Seeded ~0.5pt under the 2026-08-15 measured baseline, matching the band
      // ⤵ 75 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §17 — read them before changing the next key.
      thresholds: {
        statements: 88.15,
        branches: 76.15,
        functions: 89.6,
        lines: 91.1,
      },
    },
  },
})
