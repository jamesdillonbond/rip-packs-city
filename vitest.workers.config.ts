import { defineConfig } from "vitest/config"
import path from "path"

// THIRD coverage gate — the Cloudflare Workers.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// `workers/**` is 6,129 LOC of production ingest and proxy code that NEITHER
// existing gate measures:
//   • primary   (vitest.config.ts)            → lib/** + app/**/route.ts(x) + proxy.ts
//   • component (vitest.components.config.ts) → components/** + app/**/*Client.tsx
//
// ⚠ THIS IS A DIFFERENT KIND OF GAP FROM THE OTHER TWO, and the difference is
// the whole reason it is cheap to close. `app/**/page.tsx` is unmeasured AND
// largely untested — it needs ratchets on proxies (see
// server-page-data-access-ratchet.test.ts) because the work of testing it has
// not been done. The workers are the opposite: they are GENUINELY WELL TESTED
// already — 22 suites, 21 of which `import` the worker source and drive its
// `fetch()`/`scheduled()` handlers rather than grepping it, plus a
// worker-test-completeness rot-guard. That coverage simply had no ratchet, so
// it could rot silently, and nobody would learn it had until an ingest pipeline
// went quiet.
//
// So this config adds no tests. It puts a floor under the ones that exist.
//
// ── WHAT IS AT STAKE ───────────────────────────────────────────────────────
// These are not incidental helpers. `pack-events-ingest` alone is 2,075 LOC and
// owns `event_kind`, which the `pack_purchases_set_is_primary_drop` TRIGGER
// reads to derive `is_primary_drop` — so a regression there silently
// misclassifies primary drops as secondary sales across every pack surface, and
// the failure is a wrong NUMBER, not an error. `sales-counterparty-backfill`
// decides which address is written as a sale's buyer, where the documented
// hazard is writing the Flowty fee router as a plausible buyer.
//
// ⚠ The workers run on the Cloudflare runtime, not Node. The suites supply the
// runtime shims (__tests__/cloudflare-worker-shims.d.ts); this gate measures the
// same source under Node, so it proves the LOGIC is exercised, NOT that the
// worker deploys or that a Cloudflare-specific API behaves. Do not read a green
// gate here as a deploy check — `wrangler deploy` is still the only thing that
// tells you a worker is live (see workers/atlas-proxy/README.md, shipped INERT).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    // Only the worker suites. They are node-env like the primary run, so they
    // also execute there; this config re-runs them purely to scope `coverage`.
    include: ["__tests__/worker-*.test.ts"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["workers/**/*.ts", "workers/**/*.js"],
      exclude: [
        // Wrangler config / type shims carry no logic.
        "workers/**/*.d.ts",
        "workers/**/node_modules/**",
      ],
      // Seeded ~0.5pt under the 2026-08-15 measured baseline, matching the band
      // the other two gates use. That margin is deliberate and load-bearing on
      // this repo: concurrent sessions push code between a local run and CI, and
      // a zero-margin threshold reds an otherwise-green build (lesson 47f901a1).
      //
      // Raise these as coverage climbs; NEVER lower them to make a red build
      // pass. The ONE legitimate reason to move a number down is that files LEFT
      // the measured set (a worker was retired) — say so in this comment when
      // you do, the way vitest.components.config.ts records the 17738436 case.
      // Measured 2026-08-15 (second pass, same day): 73.79 st / 62.79 br /
      // 76.38 fn / 76.37 ln over all 24 worker source files.
      //
      // Raised from 68.2/59.0/72.6/70.7 by driving the DEEP path of
      // topshot-moments-hydrator, which was the worst file in the tree at
      // **26.3 st / 29.9 br** and is now **90.6 / 80.4**
      // (__tests__/worker-moments-hydrator-deep.test.ts). Re-seated in the SAME
      // pass that measured the gain — "keep the buffer for later" is exactly how
      // the component gate accumulated a ~13-point unguarded branch margin.
      //
      // ⚠ The aggregate is still dragged down by ONE file, and the spread is the
      // useful part — do not read 74% as "the workers are three-quarters tested":
      //   pack-events-ingest/index.ts        46.9 st / 34.1 br   <- the remaining work
      // Every other file is now 81-100% statements, and 8 are at 100%. That one
      // is the long inline `fetch()` body — a cursor loop fanning out to Flow
      // REST — the same shape the primary gate's own header explains cannot be
      // cleanly driven. The hydrator proved it CAN be driven with a table-aware
      // supabase stub plus a service-binding fetch mock; the same approach should
      // work there, and it owns `event_kind`, so it is worth the effort.
      thresholds: {
        statements: 73.3,
        branches: 62.3,
        functions: 75.9,
        lines: 75.9,
      },
    },
  },
})
