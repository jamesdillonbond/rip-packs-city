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
      // ⚠ PIN supabase-js TO THE ROOT COPY. Two worker directories
      // (topshot-moments-hydrator, pack-events-ingest) carry their OWN
      // node_modules with their own @supabase/supabase-js — 2.105.4 against the
      // root's 2.104.0. Those directories are gitignored, so they exist on a
      // developer's box and NEVER in CI.
      //
      // The consequence is not a version skew, it is a MOCK MISS: a worker
      // module importing the bare specifier resolved to the NESTED copy, which
      // is a different module id from the one `vi.mock("@supabase/supabase-js")`
      // registered. The mock silently did not apply, the worker built a REAL
      // client, and the suite made REAL network calls to the stub host that hung
      // until the 5s timeout — presenting as flakiness, on three files, only on
      // the machine where the development happens.
      //
      // Measured 2026-08-24, and the control runs both ways: 22 of 25 worker
      // suites pass, and the 3 that failed are exactly the ones whose worker dir
      // has a nested install. Every other worker dir has none.
      //
      // ⛔ The alias is the fix rather than deleting those node_modules: they are
      // a local wrangler convenience and deleting a developer's install to make a
      // test pass is the wrong direction. This makes resolution deterministic and
      // equal to CI's.
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
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      // ⚠ DISTINCT PER GATE, AND LOAD-BEARING. All three gates defaulted to
      // `coverage/`, so any two run at once fight over `coverage/.tmp`.
      // `.gitignore` has documented this invariant since it was written — "the
      // two gates must run into SEPARATE reportsDirectory dirs or they corrupt
      // each other's coverage/.tmp" — while NO config implemented it.
      //
      // ⚠ The two failure modes are NOT symmetric, and the second is the
      // dangerous one. Measured 2026-08-17 running the primary and component
      // gates concurrently:
      //   * one dies loudly: "Something removed the coverage directory ...
      //     Make sure you are not running multiple Vitests with the same
      //     coverage.reportsDirectory at the same time" — correct, diagnostic.
      //   * THE OTHER DOES NOT CRASH. It loses the deleted `.tmp` chunks and
      //     reports what is left as a MEASURED RESULT: 82.27 st / 80.61 fn
      //     against true values of 90.68 / 89.25, failing as a THRESHOLD
      //     violation. That reads as "you broke coverage" and names the
      //     author's own diff as the culprit.
      // A lost read rendered as a number, blaming the wrong thing — the same
      // class as the `?? 0` counts, in the tooling instead of the product.
      //
      // CI is unaffected (separate jobs); this is for local + agent runs.
      // Names must stay under `/coverage` or `/coverage-*` so .gitignore covers
      // them, and distinctness is pinned by
      // __tests__/vitest-gates-have-distinct-coverage-dirs.test.ts.
      reportsDirectory: "coverage-workers",
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
      // ⚠ BOTH ITEMS THIS COMMENT USED TO LIST AS UNREACHABLE ARE NOW DONE, and
      // in both cases the "we need new tooling" premise was wrong:
      //   • the SOFT-BUDGET bail-outs were said to need a fake clock. They did
      //     not — driving `Date.now` from the FETCH STUB (each event fetch
      //     advances a mutable value) is deterministic and never touches
      //     vi.useFakeTimers, so it cannot fight the AbortSignal.timeout shim.
      //   • the chunked-write partial-failure paths were said to need "a stub
      //     that fails the Nth chunk". The sequence-aware fixture ALREADY does
      //     that — an array payload yields one entry per await, so chunk N takes
      //     payload N. The only helper change needed was capturing the upsert
      //     OPTIONS, because `{ onConflict, ignoreDuplicates }` is what makes the
      //     replay safe and nothing in the suite could see it.
      // ⚠ The lesson worth keeping: BOTH were parked behind an assumed tooling
      // gap that a few minutes of reading disproved. Re-check the premise before
      // recording something as unreachable.
      //
      // What is genuinely left is the residue inside those paths — alternate
      // error shapes and the deeper backfill branches — not a named blind spot.
      // Re-seated 2026-08-20 after covering sports-proxy's retry / fingerprint-
      // rotation branches — the largest uncovered cluster in the gate.
      //   before  85.59 / 72.61 / 84.25 / 88.53   (thresholds 85.1 / 72.1 / 83.8 / 88.1)
      //   after   86.40 / 73.01 / 86.11 / 89.23
      // sports-proxy/index.ts alone moved 67.15 -> 72.14 st and 61.11 -> 72.22 fn.
      //
      // ⚠ MEASURED STABLE BEFORE RAISING, not assumed: three consecutive runs on
      // the unchanged tree returned 86.40 / 73.01 / 86.11 / 89.23 EXACTLY. That
      // matters because the COMPONENT gate's `functions` metric is documented in
      // testing-and-ci.md as wobbling ~0.1pt on an unchanged tree, and seating a
      // threshold against a single sample of a jittery metric is how a gate
      // starts failing on nothing. This gate showed no jitter, so the margin
      // below is the usual ~0.15 rather than a jitter allowance.
      //
      // Re-seated again 2026-08-20 after covering rpc-mcp-proxy's six tool
      // handlers — their argument coercion, the sniper slug routing, and the
      // lookup_wallet filter/gap branches (the next-largest uncovered cluster
      // after sports-proxy).
      //   before  86.40 / 73.01 / 86.11 / 89.23
      //   after   88.34 / 76.32 / 89.81 / 91.28
      // rpc-mcp-proxy/index.ts alone moved 74.74 -> 95.37 st and 53.75 -> 81.29 br.
      // Three consecutive runs on the unchanged tree returned those four numbers
      // EXACTLY, so the margin below is again the usual ~0.15, not jitter room.
      //
      // Every point came from ADDING tests, never from loosening an include.
      thresholds: {
        statements: 88.15,
        branches: 76.15,
        functions: 89.6,
        lines: 91.1,
      },
    },
  },
})
