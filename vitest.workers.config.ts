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
      // Measured 2026-08-15, after five raises the same day:
      // 84.97 st / 71.75 br / 83.79 fn / 88.10 ln over all 24 worker files.
      //
      // The climb, and what each step bought:
      //   68.2/59.0/72.6/70.7  gate seeded at the measured baseline
      //   73.3/62.3/75.9/75.9  topshot-moments-hydrator deep path driven —
      //                        26.3 st / 29.9 br -> 90.6 / 80.4, the worst file
      //                        in the tree (worker-moments-hydrator-deep)
      //   76.2/64.9/77.3/78.9  pack-events-ingest AllDay primary_mint leg
      //   81.6/67.7/81.9/84.4  pack-events-ingest OPENS cursor (rip -> moment
      //                        attribution, the source_pack_rip_id link)
      //   THIS                 pack-events-ingest BACKFILL MODE (the separate
      //                        cursor set, and the cross-contamination guard)
      //
      // ⚠ Each raise happened in the SAME commit that earned it. "Keep the
      // buffer for later" is exactly how the component gate accumulated a
      // ~13-point unguarded branch margin.
      //
      // ⚠ The two files that once dragged this number are closed out:
      // topshot-moments-hydrator went 26.3 -> 90.6, and ALL FOUR of
      // pack-events-ingest's modes are now driven (TopShot purchases, AllDay
      // mints, opens, and backfill).
      //
      // What is left is the tail nobody can reach with a fixture alone:
      //   • the SOFT-BUDGET bail-outs (`Date.now() - startedMs >= budgetMs`) —
      //     these need a fake clock, not a fixture, and vi.useFakeTimers must
      //     not break the AbortSignal.timeout shim this suite already patches.
      //   • the chunked-write retry/partial-failure paths under
      //     WRITE_UPSERT_CHUNK_SIZE, which need a stub that fails the Nth chunk.
      // Both are real work, not rounding error — but neither is a blind spot
      // anymore in the sense that mattered: every production INGEST path this
      // worker runs is now exercised.
      thresholds: {
        statements: 84.4,
        branches: 71.2,
        functions: 83.2,
        lines: 87.5,
      },
    },
  },
})
