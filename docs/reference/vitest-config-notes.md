# Vitest config notes — the case histories displaced verbatim from the three gate configs (2026-09-02)

> **Why this file exists.** `vitest.config.ts` was 913 lines with 40 of code; `vitest.components.config.ts` 715 / 56; `vitest.workers.config.ts` 220 / 36. The coverage thresholds — the one thing a reader opens the file for — sat at line 905 of the first. The history is valuable and this is the repo's own displacement pattern (CLAUDE.md → `docs/reference/*.md`, 2026-08-17): **nothing was deleted.** Each section below is a comment block exactly as it stood, `//` prefixes included, labelled with the file and the config line it sat directly above; the config keeps the block's first line plus a pointer to the section. ⚠ Every figure in these blocks is a DATED SAMPLE — re-measure before quoting. The lessons themselves were already promoted to [testing-and-ci.md](testing-and-ci.md); this file is the provenance, not the rule.

## §1 · `vitest.config.ts` › above `"@supabase/supabase-js": path.resolve(`

```text
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
```

## §2 · `vitest.config.ts` › above `testTimeout: 30_000,`

```text
    // ── testTimeout: 30s, raised from vitest's 5s DEFAULT (2026-08-24) ────────
    // ⚠ NOT to paper over slow tests. This repo has DOZENS of guards whose job is
    // to walk the whole tree and read every file — the honesty ratchets, the
    // completeness sweeps, the leak guards. Several sit at 1–3.5s standalone and
    // cross 5s under the FULL PARALLEL RUN's load, so WHICH ONE reds is luck:
    // measured 2026-08-24, three separate full runs each failed a DIFFERENT file
    // (worker-test-completeness at 5236ms, then no-constant-foldable-joined-
    // templates, then api-allday-listings-indexer) and every one passed in
    // isolation.
    //
    // ⚠ A guard that reds for being SLOW is indistinguishable at a glance from one
    // that FOUND something, and it trains exactly the skimming that let a real
    // failure hide in a red suite earlier the same day.
    //
    // 🚨 AND THE 5s DEFAULT WAS ACTIVELY MISLEADING, which is the stronger reason.
    // The three worker suites fixed on 2026-08-24 reported "Test timed out in
    // 5000ms" — so they read as flaky scheduling. At --testTimeout=60000 the mask
    // came off and they were ORDINARY ASSERTION FAILURES underneath, from a real
    // defect (a nested node_modules defeating vi.mock). The timeout was hiding the
    // error, not reporting one.
    //
    // The cost is stated: a genuinely HUNG test now takes 30s to fail instead of 5.
    // That is the right trade — "timeout" should mean "actually stuck", not
    // "unlucky scheduling". Full case: docs/reference/testing-and-ci.md.
```

## §3 · `vitest.config.ts` › above `reportsDirectory: "coverage",`

```text
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
```

## §4 · `vitest.config.ts` › above `include: [`

```text
      // Two tested layers are measured here: the pure lib/ logic (unit tests)
      // and the app/api route handlers (integration tests). Every route is
      // imported and its auth/param guards are exercised; a large subset also
      // drive the 2xx success/accept path by stubbing the after()/Supabase seam
      // — but the deepest inline bodies (live TopShot/AllDay GraphQL fan-outs,
      // Flow REST/Cadence scans, SSE streams) can't be cleanly driven, so a line
      // % in the 30s here is EXPECTED, not a gap to close by force; it does NOT
      // imply the happy-path business logic is fully covered. React components
      // now have their own jsdom harness (__tests__/*.test.tsx) but are measured
      // separately, not folded into this number (400+ mostly-presentational
      // files would swamp the signal). The Deno edge functions are excluded (no
      // Deno toolchain in CI); their pure logic is extracted into
      // vitest-importable modules under supabase/functions/_shared and lib/*.
      // proxy.ts (root-level Next.js middleware) is the site-wide auth +
      // allow-list security wall. It sits at the repo root, so until 2026-08-08
      // NEITHER coverage gate measured it — a new anon-reachable branch in the
      // lockdown could land with nothing to catch the coverage drop. It is now
      // gated here: isPublicPath (proxy-is-public-path.test.ts), the page-rate
      // scope (proxy-page-rate-limit.test.ts), and the async proxy() dispatch
      // chain (proxy-dispatch.test.ts) are all driven.
      // ⚠ The `.tsx` globs are NOT redundant with the `.ts` ones — they were
      // added 2026-08-11 to close an extension blind spot. Both gates addressed
      // handlers as `route.ts` and lib as `lib/**/*.ts`, so 44 `route.tsx`
      // files (43 OG social cards + the 844-LOC Trophy Case PDF, ~8,000 LOC)
      // plus lib/og/entity-card.tsx and lib/warmup/WarmupContext.tsx were
      // measured by NEITHER gate, and 43 of the 44 routes had no test at all.
      // These routes have a known silent failure mode — HTTP 200 with a
      // ZERO-BYTE body, blanking every social unfurl while status checks stay
      // green — so they are exactly the wrong thing to leave unmeasured.
      // __tests__/api-route-tsx-test-completeness.test.ts fails CI if either
      // `.tsx` glob is removed, or if a new route.tsx lands with no test.
      // ⚠ The route globs are `app/**`, NOT `app/api/**`. Route handlers are a
      // FILE CONVENTION, not a directory one, and two live outside app/api:
      // app/sitemap.xml/route.ts (the <sitemapindex> at the GSC-registered URL)
      // and app/sitemap/[id]/route.ts (the five segment children). An
      // `app/api/**` glob missed both — the same blind-spot class as the `.ts`
      // vs `.tsx` gap below, on the SEO surface, where the failure is silent:
      // one unescaped `&` makes a segment malformed and Google drops every URL
      // in it while the route still returns 200.
      //
      // ⚠ `supabase/functions/_shared` ADDED 2026-08-20. Those 29 modules exist
      // ONLY to be testable — they are the vitest-importable half of the Deno
      // edge functions, which no gate can execute (`edge-deno` runs `deno check`
      // + an informational lint, never a test). All 29 were already referenced
      // by a test, and `edge-shared-test-completeness.test.ts` guards that they
      // stay that way. But they matched NO gate's `include`, so they were
      // **tested and unmeasured**: nothing ratcheted them, and a new `_shared`
      // module could land at 0% behind a passing completeness check that only
      // asks whether a test file NAMES it. Measured before widening —
      // 98.31 stmts / 92.76 branch / 100 funcs, above the aggregate in every
      // metric — so this RAISES the gate rather than buying headroom, which is
      // the only shape of include-widening this file permits.
```

## §5 · `vitest.config.ts` › above `thresholds: {`

```text
      // CI ratchet — set just below the current baseline so a coverage DROP
      // fails CI while normal noise doesn't. Raise these as coverage climbs;
      // never lower them to make a red build pass.
      //   2026-07-12 (initial): stmts 34.3 / branch 26.5 / funcs 39.4 / lines 36.5
      //   2026-07-12 (intelligence-core tests: market-analytics buildMarketSnapshot,
      //     pack-drops scoreDrop, pack-deals getPackDeals, pro-tier gating,
      //     breaks/server-authz, set-completers fetcher):
      //     stmts 35.5 / branch 28.1 / funcs 40.7 / lines 37.6
      //   2026-07-12 (2nd wave: market-truth merge layer [flowscan/external/edition/
      //     topshot/market-sources], insight-board fetchers, alerts, concierge FMV
      //     distribution + invariants, allow-list prewarm, seo + sitemap-data):
      //     stmts 38.0 / branch 30.9 / funcs 44.7 / lines 40.2
      //   2026-07-12 (3rd wave: studio-sales-history drain, pinnacle flow-events +
      //     sniper feed + sniper helpers, rewards/pro/badge-art/marketplace-status/
      //     top-sales, telemetry trackers + welcome-email + username-resolver hook):
      //     stmts 39.3 / branch 31.9 / funcs 46.5 / lines 41.5
      //   2026-07-13 (4th wave: Flow GraphQL clients [topshot-graphql/topshot/
      //     allday(Graphql)], allday-edition-onchain + allday-video + flow-resolve +
      //     fcl-config, topshot-username-resolve, evm-rpc, pinnacleFlowty,
      //     trade-escrow fcl-submit + sign-deposit, og/img-data, editions-hydrate):
      //     stmts 41.0 / branch 33.5 / funcs 48.7 / lines 43.2
      //   2026-07-13 (5th wave: wallet-backfill-helpers [4%->88%], live-pack-listings,
      //     soldpacks, topshot-offer-fill, flowty-username, verify-wallet-gql,
      //     solana-das, wallet-backfill-lock, parallel-premiums/market-pulse boards,
      //     challenges-ingest, concierge-bridge, pipeline-chain, local-market-files,
      //     saved-wallet-for-collection, discord verify/commands, auth clients,
      //     useBadgeTaxonomy): stmts 43.4 / branch 35.6 / funcs 51.0 / lines 45.5
      //   2026-07-16 (6th wave: sniper-feed pure helpers [parseListingPrice /
      //     extractBadgeSlugs / BADGE_LABELS] extracted to lib/sniper/feed-helpers
      //     and unit-tested, topshot/set-plan route [0%->covered], stripe/webhook
      //     event-handler branches [checkout.session.completed, subscription
      //     updated/deleted, invoice skip + error->503 paper trail]):
      //     stmts 43.67 / branch 35.92 / funcs 51.25 / lines 45.79
      //   2026-07-16 (sniper-feed pure helpers extracted to lib/sniper/feed-helpers
      //     [parseListingPrice, extractBadgeSlugs, sortSniperDeals, mergeDedupeByEditionKey],
      //     + route tests for topshot/set-plan [0%->covered], stripe/webhook event
      //     branches, and cron/ingest-topshot-challenges [0%->covered]):
      //     stmts 43.79 / branch 36.05 / funcs 51.45 / lines 45.9
      //   2026-07-16 (pack-EV pricing: bestPrice fallback ladder + serialPremiumLabel
      //     extracted from app/api/pack-ev/route.ts to lib/pack-ev-pricing + tested):
      //     stmts 43.84 / branch 36.11 / funcs 51.5 / lines 45.93
      //   2026-07-16 (re-baseline): the prior bumps left near-zero buffer, so a
      //     concurrent feature merge (af087a5c sentinel metric-refresh, new
      //     uncovered fns/branches) dropped funcs 51.5->51.47 / branch 36.11->36.09
      //     and reddened CI. Current actual on merged main: stmts 43.82 / branch
      //     36.09 / funcs 51.47 / lines 45.91. Thresholds reset to a ~0.1-0.2 buffer
      //     below actual so ordinary concurrent churn doesn't trip the gate — still
      //     a net ratchet UP from the session-start floor (43 / 35 / 50 / 45). Raise
      //     as coverage climbs; keep a buffer this size to survive concurrent merges.
      //   2026-07-16 (route-integration harness + edition-floor POC): a reusable
      //     fetch+Supabase seam harness (__tests__/helpers/route-harness.ts) drives
      //     the actual edition-floor GET/POST body (18%->61% stmts on that route),
      //     lifting the aggregate to stmts 44.07 / branch 36.32 / funcs 51.85 /
      //     lines 46.14. Thresholds bumped to lock in most of the gain while
      //     keeping the ~0.2 concurrent-churn buffer.
      //   2026-07-16 (harness rollout: best-offers + market-feed + market-analytics
      //     integration tests via route-harness — makeSupabaseFixture's empty
      //     default drives RPC-heavy read bodies end-to-end): stmts 44.32 / branch
      //     36.54 / funcs 52.1 / lines 46.4. Ratchet bumped, ~0.2 buffer kept.
      //   2026-07-16 (harness rollout cont.: edition-history + market integration
      //     tests): stmts 44.46 / branch 36.73 / funcs 52.16 / lines 46.52.
      //   2026-07-16 (harness rollout cont.: top-sales + sets-db integration
      //     tests): stmts 44.48 / branch 36.75 / funcs 52.21 / lines 46.54.
      //   2026-07-17 (flagship + read-route rollout: sniper-feed handler
      //     orchestration [filters/limit/shaping via a stubbed getOrSetCache],
      //     fmv-recalc auth+ack [after() stubbed], overview-stats all-empty fan-out):
      //     stmts 44.51 / branch 36.8 / funcs 52.31 / lines 46.57.
      //   2026-07-17 (support-chat dedicated harness: deriveIdentity/cookies +
      //     Anthropic + Supabase seams stubbed to drive the Message-required 400 +
      //     anonymous greeting fast-path on the 2,900-line concierge route):
      //     stmts 44.66 / branch 36.93 / funcs 52.41 / lines 46.72.
      //   2026-07-17 (deep-loop layer Phase 1: scripted Anthropic client drives
      //     support-chat's tool-use loop — dispatch/iteration/escalation/MAX_ITER
      //     fallback; support-chat route 11%->22.6%): stmts 44.86 / branch 37.14 /
      //     funcs 52.63 / lines 46.95.
      //   2026-07-17 (deep-loop Phase 2: Component B [gqlRoute + sequence-aware
      //     fixtures + proper-thenable builder] + sniper-feed compute driven via the
      //     Supabase-sourced ts_listings pool — route 9%->48.2%): stmts 45.02 /
      //     branch 37.18 / funcs 52.88 / lines 47.11.
      //   2026-07-17 (deep-loop Phase 3: pack-ev fresh EV compute driven via
      //     gqlRoute — PACK_DYNAMIC_QUERY + paginated packEditionsV3 + EV loop;
      //     route 18%->69%): stmts 45.29 / branch 37.41 / funcs 53.26 / lines 47.4.
      //   2026-07-17 (deep-loop Phase 4, ops-critical rollout: fmv-recalc deferred
      //     sweep [6.5%->63.9% — every exit path logs, grail/mis-key guards],
      //     sentinel battery [14.5%->86.1% — saturation/empty-error inconclusive
      //     pins], check-alerts sweep [12.5%->88.3% — debounce/cooldown/fatal-log],
      //     wallet-search enrichment body [27%->79%], support-chat streaming
      //     variant, admin bridges + lib/stripe 0%->covered; harness gains
      //     makeInstrumentedSupabaseFixture + anthropic error turns):
      //     stmts 47.92 / branch 39.71 / funcs 56.72 / lines 50.05.
      //   2026-07-17 (deep-loop Phase 5 — sales-indexer family deep-drive via
      //     JSON-CDC fixtures [helpers/flow-cdc-fixture.ts]: TopShot
      //     7.5%->80.5% lines, AllDay 8.1%->78.9%, Golazos 9.4%->54.1%,
      //     UFC 11.6%->53.4%): stmts 50.41 / branch 41.13 / funcs 58.15 /
      //     lines 52.59.
      //   2026-07-17 (deep-loop Phase 6, final wave — history backfills
      //     [topshot 16.3->90.1%, allday 36->87%], listings indexers [allday
      //     11.3->94.2%, golazos 81.8%, ufc 74.6%], smoke-test 9->78.1%,
      //     ingest 5.1->85.8%, badge-sync 14->92.5%, cache-refresh 76.1%,
      //     allday-sets 83.6%, seed-wallet-refresh 81.7%, offers-sweep 89.6%;
      //     plus first CF-worker tests + component spot-fills outside this
      //     measure): stmts 56.63 / branch 45.71 / funcs 65.2 / lines 58.86.
      //   2026-07-17 (deep-loop Phase 7, long-tail sweep — concierge tool arms +
      //     22 route suites: listings/offers indexers [pinnacle/topshot/allday],
      //     the Flowty listing-cache family [TS/AllDay/Golazos/UFC + retries],
      //     the six remaining sales-history backfills, the unmapped drains,
      //     wallet-backfill + -multicollection, evm-transfers-ingest,
      //     topshot-fmv-populate, nine admin backfill/tool routes; new helper
      //     delete-recorder pins the upsert-then-purge contract):
      //     stmts 68.18 / branch 54.32 / funcs 74.21 / lines 70.51.
      //   2026-07-17 (deep-loop Phase 8, final long-tail — ~30 more route suites
      //     across 5 batches: pinnacle/candy sales indexers + pinnacle-events +
      //     allday-seed + resolve-buyers + ownership-onchain-walk (87-96%);
      //     bulk-classify/backfill-*/fmv-backfill/ingest-backfill/wallet-cost-basis
      //     (84-98%); wmc-fmv-populate/sync-dune/ufc-drain/deal-floor/laliga-pack-ev/
      //     lock-check/alerts-send/pinnacle-metadata (68-99%); market/market-analytics/
      //     early-access/collection-moments/profile-*/alerts/support-chat-context/
      //     allday-pack-listings (47-90%); breaks draft+distribute + discord (batch E)):
      //     stmts 73.97 / branch 58.81 / funcs 78.99 / lines 76.54.
      //   2026-07-19 (test-coverage-analysis pass — unify + pin the pack-EV
      //     pricing 3rd copy [computeDualPrice added to _shared + a lib↔_shared
      //     parity matrix + an edge-fn source-drift guard], extract & unit-test the
      //     sales-counterparty-backfill decoder [Withdraw seller / TopShot-only
      //     buyer / AllDay-UFC custodian trap / multi-moment guard], extract &
      //     test pack-events deriveCurrency, and drive /api/sets classifyTier +
      //     bottleneck + completion math end-to-end): stmts 74.47 / branch 59.4 /
      //     funcs 79.7 / lines 77.07. (Most new tests cover workers/edge _shared,
      //     which are outside the include glob, so the measured aggregate moved
      //     only via the in-scope /api/sets + lib/pack-ev-pricing exercise.)
      //   2026-07-19 (test-coverage-analysis pass, cont.: extract & unit-test the
      //     pack-events-ingest CDC decoder [unwrapCdc/extractTypeId → cdc.ts, all
      //     JSON-CDC type branches], and drive /api/profile/tier-breakdown's
      //     aggregation core end-to-end [per-address de-dupe, 0x normalization,
      //     per-wallet RPC-error tolerance, coverage_zero, TIER_ORDER sort]):
      //     stmts 74.55 / branch 59.48 / funcs 79.8 / lines 77.16.
      //   2026-07-19 (test-coverage-analysis pass, cont.: DB-invariant harness
      //     [supabase/tests/*.sql run against postgres:16 in a new non-blocking
      //     db-tests CI job; _norm_player + fmv_snapshots_block_phantoms pinned,
      //     with __tests__/db-invariants-drift-guard.test.ts keeping the embedded
      //     DDL in lockstep with the migrations], and drive /api/wallet-hold-time
      //     end-to-end [guards, non-TopShot short-circuit, username resolution,
      //     hold-time bucketing via fake timers]): stmts 74.66 / branch 59.55 /
      //     funcs 79.85 / lines 77.25. (The SQL harness + drift guard are outside
      //     the include glob; the aggregate moved via the in-scope hold-time route.)
      //   2026-07-19 (cont., "1 and 2": +2 DB-invariant guards
      //     [compute_listing_divergence null-safe price mismatch, resolve_moment_id
      //     6-branch dispatch precedence incl. wmc TS-collision + active-listing
      //     tie-break] taking the harness to 10 pins, and deepened three route
      //     success/branch layers — profile/bio POST+PATCH, wallet-packs
      //     username-resolve/pagination/error-degrade, profile/teams GET-map +
      //     POST validation/replace/award): stmts 74.9 / branch 59.8 / funcs 80.0
      //     / lines 77.5. (The +2 SQL guards are outside the include glob; the
      //     aggregate moved via the three in-scope route bodies.)
      //   2026-07-20 (test-coverage-analysis "do all of them" pass): extract +
      //     unit-test the supply-weighted pack-EV math shared by the 3 no-packOdds
      //     edge fns (_shared/pack-ev-supply-weighted + source-drift guard),
      //     +2 DB-invariant pins (backfill_allday_edition_jersey +
      //     refresh_topshot_fmv_display_guard → 12 pins), extract + test the
      //     topshot-moments-hydrator parse core (workers/.../parse.ts), pull the
      //     sniper deal-list shaping + collection sort/dedup into lib/ (in-scope,
      //     the ratchet mover), and a guard/branch pass on profile/activity +
      //     profile/recent-searches + wallet-cache routes:
      //     stmts 75.32 / branch 60.19 / funcs 80.68 / lines 77.91. Thresholds
      //     bumped with the usual ~0.15 buffer under actual for concurrent churn.
      //   2026-07-20 (test-coverage-analysis pass, cont. — "keep going"): drive
      //     lib/topshot-badges fetchBadgeEditions filter/normalize + wrappers
      //     (17%->95% branch), and deepen four read routes to their success/branch
      //     layers — profile/watchlist (GET enrichment + POST/DELETE + rewards,
      //     13%->76%), profile/follows (bio-join + follow/unfollow, 21%->91%),
      //     profile/cost-basis-summary (P&L dedup/normalize aggregation, 20%->80%),
      //     profile/activity (fan-out + enrichment): stmts 75.64 / branch 60.83 /
      //     funcs 81.09 / lines 78.24. Thresholds bumped, ~0.15 buffer kept.
      //   2026-07-20 (test-coverage-analysis pass, round 3): cover the last two
      //     low-coverage in-scope libs — lib/concierge/pinnacle-router
      //     (searchPinnacleDeals/getPinnacleFmv/explainPinnacleFmv/searchPinnacleByName
      //     via a chainable supabase mock, 27%->70% branch) and lib/rtr-picks
      //     pickTonightsBest (41%->83% branch): stmts 75.79 / branch 61.03 /
      //     funcs 81.32 / lines 78.39. Thresholds bumped, ~0.15 buffer kept.
      //   2026-07-20 (test-coverage-analysis pass, round 4): drive two big safe
      //     routes to their success/decode layers — wallet-preflight (Flow REST
      //     mock → flattenJsonCadence type branches + 502 modes, 19%->75% branch)
      //     and profile/collection-breakdown (dedup-per-wallet merge + slug
      //     color-code + sort, 23%->67%): stmts 76.02 / branch 61.25 / funcs
      //     81.53 / lines 78.63. Thresholds bumped, ~0.15 buffer kept.
      //   2026-07-20 (test-coverage-analysis pass, round 5): three more big safe
      //     routes to their success layers — fast-break/optimize (full lineup +
      //     acquisition-gap fan-out through the real optimizer, 19%->63% branch),
      //     cart/validate (Flow parseCadence + priceChanged/sniped + error
      //     results, 13%->84%), send-digest (compose+Resend loop, 20%->75%):
      //     stmts 76.27 / branch 61.52 / funcs 82.0 / lines 78.86. Thresholds
      //     bumped, ~0.15 buffer kept.
      //   2026-07-20 (test-coverage-analysis pass, round 6): route tail —
      //     fast-break/today (games/projections join, 22%->62%), fast-break/uses
      //     (enrichment + remainingUses, 23%->73%), breaks/[id]/validate-recipients
      //     (status gate + Flow + spot updates, 13%->87%): stmts 76.49 / branch
      //     61.67 / funcs 82.17 / lines 79.1. Thresholds bumped, ~0.15 buffer.
      //   2026-07-25 (test-coverage pass — deferred after()-body drives): the
      //     three lowest-branch cron routes had their DEFERRED dispatch bodies
      //     driven for the first time (siblings only stubbed after() to a no-op),
      //     pinning the silent-failure error/degrade legs — alerts-dispatch
      //     18%->77% br, refresh-serial-fmv-multipliers 20%->80%, and
      //     refresh-conflated-editions 7%->68% (fatal conflation-refresh vs
      //     non-fatal remap/thin-FMV legs). Live actual: stmts 77.57 / branch
      //     63.14 / funcs 83.39 / lines 80.08. Thresholds bumped with a wider
      //     ~0.4 buffer (not the usual 0.15) because concurrent same-day sessions
      //     were actively pushing — a tight margin would red their otherwise-green
      //     merges (lesson 47f901a1).
      //   2026-07-25 (deferred after()-body drives, cont. 2+3): five more cron
      //     routes' deferred bodies driven — backfill-pack-rip-metadata 13->87.5%
      //     br, refresh-pack-grail-metrics-mv 25->75%, snapshot-pack-asks 11->83%
      //     (per-collection error isolation), run-insider-detectors 20->85%
      //     (per-collection detector fan-out + candidate-count null-safety), and
      //     pinnacle-wmc-render-id 24->77.5% (GQL resolve + sales-drain best-effort
      //     legs). Live actual: stmts 78.13 / branch 63.46 / funcs 83.86 / lines
      //     80.68. Thresholds bumped to lock in the session's gains, keeping a
      //     comfortable ~0.55 buffer for concurrent churn.
      //   2026-07-25 (cont. 4+5): the 2 biggest fetch-based backfill routes
      //     (tier-backfill 24->89% br, wallet/seed 21->81% br — chainable-builder
      //     + fetch-fixture, asserting on the sync response body), plus the
      //     flagship sniper-feed route driven from 8.8%->35% branch: a handler
      //     contract test (getOrSetCache seam → dispatch/applyOuterFilters/limit/
      //     error legs) and a REAL computeAllDaySniperFeed drive (live GQL edge →
      //     buildDeal/fmv-join/#1+jersey specials/filters, and the RPC-fallback
      //     path). Live actual: stmts 78.7 / branch 64.08 / funcs 84.4 / lines
      //     81.26. Bumped to lock the session's cumulative gains, ~0.55 buffer.
      //   2026-07-25 (cont. 6+7): golazos-sniper-feed 17->82% br, analytics-smoke
      //     11->87% (saturation-vs-hard-fail classifier), detect-league-drift
      //     11->79%, backfill-onchain-ids 4->90% (UUID-vs-integer resolve),
      //     pinnacle-ingest 10->89% (edition dedup + sales timestamp math), and a
      //     dent on the flagship support-chat concierge 27->33% br (the uncovered
      //     tool-arm input guards: log_feature_request / search_across_collections
      //     / explain_fmv / get_edition_sweep / get_set_completion_cost /
      //     manage_deal_subscriptions / get_special_serial_owners / check_wallet).
      //     Live actual: stmts 79.42 / branch 65.08 / funcs 84.89 / lines 82.0.
      //     Bumped to lock the gains, ~0.55 buffer.
      //   2026-07-25 (cont. 8): panini/listings 9->73% br (OpenSea+CoinGecko fetch
      //     + module-cache stale-fallback), admin/flowty-analytics 27->76% br (the
      //     mv_flowty_* fan-out + resolveRange period/bucket matrix + ranked
      //     leaderboards), and allday-pack-listings 29->67% br (a companion test
      //     that CAPTURES the after(runPackListings()) promise to drive the
      //     grouping/lowest-ask/upsert math the sibling deep test no-ops). Live
      //     actual: stmts 79.95 / branch 65.51 / funcs 85.21 / lines 82.55. Bumped
      //     to lock the gains, ~0.55 buffer.
      //   2026-07-25 (cont. 9): the shelved Trade Hub / trade-chain state machines
      //     (503-gated in prod but full of real branches for go-live) — propose
      //     29->82% br, deposit-callback 12->86%, cancel-callback 14->93%,
      //     execute 10->90%, and admin/reclaim-expired-trades 20->70%. Each drives
      //     the auth/validation/lookup(404/500)/party-check/transition-table/insert
      //     legs behind RPC_TRADE_ESCROW_ADDRESS. Live actual: stmts 80.34 / branch
      //     65.84 / funcs 85.31 / lines 82.98 (statements crossed 80%). Bumped to
      //     lock the gains, ~0.55 buffer.
      //   2026-07-25 (cont. 10): breaks/[id]/lock 11->89% br (sealed-height +
      //     spot-capture guards), owned-flow-ids 25->75% (FCL ids+editions fan-out),
      //     auth/fcl-verify 25->80% (nonce lifecycle + link/mint paths),
      //     teams/follow 29->85% (GET/POST/DELETE RLS toggle), profile/market-pulse
      //     32->85% (count paths + tier-floor grouping + cache), and
      //     admin/apply-fmv-haircut 33->78% (dry sync + live after() dark-run guard).
      //     Live actual: stmts 80.77 / branch 66.25 / funcs 85.53 / lines 83.44.
      //     Bumped to lock the gains, ~0.55 buffer.
      //   2026-07-25 (cont. 11): admin/beta-activity 26->89% br (allow_list→auth→
      //     usage_events rollup), admin/resend-welcome-batch 24->70% (emails/dormant
      //     modes + prewarm loop), admin/feedback 30->84% (filters + STATUS_RANK sort
      //     + buildStats tallies), profile/verify-link 33->93% (HybridCustody nonce +
      //     link/self paths + rate limit), and profile/top-movers 32->82% (saved-
      //     wallet merge + edition dedup + owner resolution). Live actual: stmts 81.2
      //     / branch 66.69 / funcs 85.99 / lines 83.85. Bumped to lock, ~0.55 buffer.
      //   2026-07-25 (cont. 12): admin/evm-indexer-status 34->91% br (cursor/tip lag
      //     + per-chain sealed-tip), cron/resolve-wallet-usernames 34->83% (deferred
      //     hit/miss/error tri-state resolver), cron/pinnacle-listings-reconcile
      //     (retired-path reachable legs; the reconcile branch is dead code), and
      //     cost-basis-backfill 34->77% (FCL owned-ids + chunked RPC accumulation).
      //     Live actual: stmts 81.43 / branch 66.84 / funcs 86.22 / lines 84.09.
      //     Bumped to lock the gains, ~0.5 buffer.
      //   2026-07-25 (cont. 13): the flagship fmv endpoint 34->74% br (GET single +
      //     POST batch + history + serial multiplier), alerts/subscriptions 34->81%
      //     (GET/POST/PATCH/DELETE CRUD + sanitize coercion), and
      //     admin/backfill-topshot-onchain-art 18->76% (Flow-REST getCIDs art fill +
      //     dead-media-only writes). Live actual: stmts 81.81 / branch 67.18 / funcs
      //     86.49 / lines 84.46. Bumped to lock the gains, ~0.5 buffer.
      //   2026-07-25 (cont. 14): deepened five existing shallow-sibling route tests —
      //     wallet-sales-history ->77% br (Pinnacle text-id branch + username
      //     resolve/throw + buy-side + TopShot note + both 500s), alerts/channels
      //     40->90% (email verify-send + telegram/discord deep links + DELETE +
      //     maskTarget), bots/telegram 66->85% (all commands + concierge markdown
      //     strip + chunking + send() fetch), profile/resolve-and-associate 32->88%
      //     (the after() fan-out: wallet-search + UFC scan + aggregate RPC ok/err),
      //     and auth/callback 31->87% (code exchange + OTP verify + off-site redirect
      //     guard). Live actual: stmts 82.15 / branch 67.5 / funcs 86.71 / lines
      //     84.82. Bumped to lock the gains, ~0.5 buffer.
      //   2026-07-25 (cont. 15): drove three deferred/GQL-fan-out routes that the
      //     sibling test only auth-pinned — ingest/candy-editions 36->80% br (the
      //     captured after() DAS walk: burnt/pack skip + edition dedup + serial→wmc
      //     + upsert errors + discovery-pending + throw), admin/backfill-pinnacle-
      //     sales-render-id 45->82% (the GQL drain loop: node vs edition render_id,
      //     non-ok/gql-errors, set RPC ok/err, residual), and cost-basis-gql-backfill
      //     63->78% (owned-ids throw + the priced/no-price/gqlError loop + skip-
      //     existing + upsert error + pagination). Live actual: stmts 82.45 / branch
      //     67.69 / funcs 86.97 / lines 85.11. Bumped to lock the gains, ~0.5 buffer.
      //   2026-07-25 (cont. 16): deepened three more shallow-sibling route tests —
      //     admin/feedback/[id] 54br->92% (all field validators + the full
      //     duplicate-status resolution block: proposed vs existing lookup, target
      //     500/missing/self-ref, final 500/404), and the two badge seeders
      //     seed-allday-badges + seed-golazos-badges 27br->81% each (editions-page
      //     500 + the classify→build→upsert path + the upsert-error branch). Live
      //     actual: stmts 82.62 / branch 67.85 / funcs 87.19 / lines 85.28. Bumped
      //     to lock the gains, ~0.5 buffer.
      //   2026-07-25 (cont. 17): drove two more deferred/sweep routes — cron/panini-
      //     ingest 40br->80% (the captured after() walk: editions dedup+upsert+err,
      //     fmv delete-then-insert, pack upsert, serials dedup+upsert+err, logRun
      //     success/catch, + the CRON_SECRET auth arm) and the 427-line
      //     admin/backfill-topshot-subedition-circulation 32%->78%br (select 500,
      //     ?probe=1 distribution, gql_fault + cursor_loop terminations, and the
      //     GREATEST circulation update + ask capture + pipeline_runs log, incl. the
      //     update-error ok:false and the ambiguous-across-sets skip). Live actual:
      //     stmts 82.89 / branch 68.06 / funcs 87.47 / lines 85.5. ~0.5 buffer.
      //   2026-07-25 (cont. 18): small-surface sweep off the per-file gate table —
      //     profile/favorites 25br->~90% (GET 500 + POST upsert/500 + all of DELETE),
      //     profile/export-csv 25br->90% (row emission, csvEscape comma/quote/newline,
      //     per-wallet RPC-error skip, outer catch), profile/first-run-tour 37.5br->
      //     ~90% (GET 500 + POST stamp/reset/500), and a FIRST test for
      //     app/api/wallet/profile (0 -> 97%st/87%br) covering its in-process cache:
      //     miss->hit, 30s TTL expiry, 500-entry LRU eviction, and no-cache-on-error.
      //     Live actual: stmts 83.02 / branch 68.18 / funcs 87.56 / lines 85.64.
      //   2026-07-25 (cont. 19): cron/price-snapshots 30br->~90% (POST RPC error/
      //     throw/null-data 500s + the whole GET status probe incl. staleness math),
      //     cron/daily-portfolio-snapshot (auth was covered, the after() body was
      //     not — now drives the snapshots_written/rows_written/NaN-coercion tallies
      //     and the ok:false error+throw legs the 202 hides), and pro-payment-scanner
      //     32%st/40br->100%/85% by stubbing global fetch for the Flow REST JSON-CDC
      //     scan the old test called unmockable. Live actual: stmts 83.14 / branch
      //     68.25 / funcs 87.72 / lines 85.76.
      //   2026-07-25 (cont. 20): classify-unknowns 32%st/37br -> 98%/87% (the whole
      //     GQL classification loop: price>0 marketplace vs 0/null pack_pull, and
      //     every failure mode — non-ok HTTP / missing data node / thrown fetch /
      //     failed update — counted unchanged so nothing is misclassified), and
      //     insider-signals 45br->~90% (the authed legacy pool read + its 500, the
      //     limit clamp to [1,50] incl. the NaN default, and the ufc->ufc_strike DB
      //     slug map vs unmapped passthrough). Live actual: stmts 83.25 / branch
      //     68.36 / funcs 87.74 / lines 85.87.
      //   2026-07-25 (cont. 21): allow-list/prewarm-drain 45br->~90% (the captured
      //     after() drain: per-row poll-budget arithmetic, and the throw path that
      //     must mark a row `failed` so it is never left stuck in_progress), and
      //     resolve-topshot-username 32br->~90% (its pipeline_runs LOGGING POLICY —
      //     a live-GQL hit logs, a cached layer-1-4 hit must not, a miss logs
      //     ok:false at 200, and empty_username stays a silent 400). Live actual:
      //     stmts 83.31 / branch 68.44 / funcs 87.78 / lines 85.93.
      //   2026-07-25 (cont. 22): ufc-wallet-scan 40br->~85% (scan 502, first-chunk
      //     enrich failure, and the background drain incl. the documented
      //     nextStart-not-enrichedSoFar cursor, the stall guard, and the error stop)
      //     + cron/populate-pinnacle-wmc-fmv 37.5br->~90% (the after() populate's
      //     examined/updated accounting, the never-negative rows_skipped, and the
      //     error/throw ok:false legs). Live actual: stmts 83.4 / branch 68.51 /
      //     funcs 87.83 / lines 86.03.
      //   2026-07-25 (cont. 23): the wallet-backfill-allday / -pinnacle twins
      //     64%st/44br -> 100%/92.6% each. A prior revision declared sync mode
      //     untestable "because it needs live Cadence"; it only needed
      //     run{AllDay,Pinnacle}DetailsBackfill stubbed. Now covers both modes —
      //     the deferred after() body + its record_wallet_backfill_scan (and that
      //     call failing), and the ?sync=true checkpoint payload incl. the
      //     max_duration_ms [30s,540s] clamp and ?checkpoint= resume — plus the
      //     force flag (body OR query) and the resolveWalletInput 400. Live actual:
      //     stmts 83.47 / branch 68.59 / funcs 87.88 / lines 86.11.
      //   2026-07-25 (cont. 24): cron/classify-acquisitions-multicollection 34%st/26br
      //     -> 100%/94.7% (the after() 3-collection loop: per-collection tallies, the
      //     alternate RPC counter keys, the AllDay 80/tick cap, and failure ISOLATION
      //     — one collection erroring or throwing must not stop the others, and only
      //     the FIRST error is kept), profile/portfolio-history 46br->~90% (the whole
      //     POST upsert + the days cap + wallet-branch precedence), and
      //     cron/snapshot-institutional-wallets 46br->~90% (the 3-attempt edge retry
      //     loop under fake timers: recover-on-2, exhaust-to-502, thrown-fetch, and
      //     the non-JSON body fallback). NOTE: the "...ulticollection" row at 26br in
      //     earlier gate tables was this cron route, NOT wallet-backfill-
      //     multicollection (already 92%st/76br). Live actual: stmts 83.58 / branch
      //     68.71 / funcs 87.94 / lines 86.24.
      //   2026-07-25 (cont. 25): the ufc + golazos sales-indexer siblings
      //     ~52%st/32br -> ~63%/43 each. The existing deep test drove one happy
      //     path per sibling; the ~550-line shared runIndexer body was otherwise
      //     dark. Added a describe.each over BOTH routes (separate files, so each
      //     needs its own drive) covering the unmapped_sales park when an edition
      //     can't be resolved, the 23505 all-or-nothing insert contract (batch
      //     error -> row-by-row retry, dupe AND non-dupe), the cursor-at-sealed
      //     short-circuit, and the no-cursor-row cold start. Live actual: stmts
      //     83.79 / branch 68.86 / funcs 88.12 / lines 86.46.
      //   2026-07-25 (cont. 26): sniper-feed 50.3%st/34.9br -> 82.8%/62.7. The
      //     enrichment fan-out (fetchFmvBatch / fetchBadgesByPlayers /
      //     fetchJerseyNumbers / attachSerialFmvEstimates) was dark because every
      //     lookup table was empty, AND because makeSupabaseFixture captures its
      //     fixtures object BY REFERENCE — a test doing `fx.tables = {...}`
      //     detached it, so the pre-existing "populated pool" case was silently
      //     asserting on ZERO deals. Fixture now reads fx.tables through a live
      //     Proxy. Live actual: stmts 84.18 / branch 69.29 / funcs 88.28 / lines
      //     86.87.
      //   2026-07-25 (cont. 27): fmv-recalc 56.7%st/43.9br -> 74.9%/50. Its
      //     ASK-fallback + backfill steps are each gated on `rows.length > 0` and
      //     the shared QUIET_TAIL returned [] for every query_sql probe, so all
      //     five bodies were dark. rpc:query_sql is sequence-aware, so feeding
      //     rows at a known call index lights exactly one step. Two gotchas worth
      //     keeping: Step 1a pages editions via the fmv_recalc_edition_page RPC
      //     (NOT the sales table) and an empty page early-returns before any
      //     fallback runs; and the sweep also early-returns with no in-window
      //     sales. Live actual: stmts 84.43 / branch 69.35 / funcs 88.51 / lines
      //     87.09.
      //   2026-07-25 (cont. 28): support-chat's 6 insight-board tool arms (the
      //     2026-07-20 read-only market/ecosystem reads) driven through the real
      //     tool-use loop — enum guards, limit clamps, and every fetchPublicInsight
      //     shaping/failure branch (meta/stats/headline passthrough, non-ok HTTP,
      //     an error-carrying payload, bare-array rows). Route only moved
      //     46.9%st->47.3: the remaining mass is ~25 bespoke per-tool Supabase
      //     fixtures, which is exactly the "deepest inline body" case this comment
      //     block says NOT to force. Live actual: stmts 84.44 / branch 69.37 /
      //     funcs 88.51 / lines 87.1.
      //   2026-07-25 (cont. 29): four more routes re-derived from the gate table —
      //     analytics/insider/signals 45br->~90% (the moment->editions buyback NAME
      //     FALLBACK + the unnamed-row drop, which is the honesty rule that stops
      //     "Insider buyback · Unknown moment" rendering), rtr/state 40br->~90%
      //     (every tierFromPoints threshold boundary, since an off-by-one there
      //     silently mis-ranks a user), mcp/keys 41.7br->~90% (wallet ownership
      //     403, bare-hex normalization, label trim/80-cap, and the multi-wallet
      //     list merge skipping a failing wallet), and cron/allday-lock-refresh-
      //     batch 37.5br->~85% (auth arms, GET alias, the fatal-catch paper trail,
      //     and the soft-deadline break). Live actual: stmts 84.6 / branch 69.55 /
      //     funcs 88.58 / lines 87.25.
      //   2026-07-25 (cont. 30): allday-lock-refresh 37.5br->100% (0x normalization
      //     + both 500 shapes), admin/resend-welcome 46br->~90% (row lookup 500/404,
      //     the active-only status gate, reset 500, and the force=true inline run
      //     incl. marking the row failed rather than leaving it stuck), and
      //     wallet-backfill-candy 46br->~85% (the deferred DAS walk: collection
      //     gate, burnt/pack skip, and the queried-wallet stamp that stops a stale
      //     DAS owner misattributing a row). Live actual: stmts 84.7 / branch 69.62
      //     / funcs 88.76 / lines 87.36.
      //   2026-07-25 (cont. 31): rtr/lock-roi 45br->~85% (the in-process cache
      //     hit, the wmc read 500, the fmv_current-preferred-over-wmc join, the
      //     no-usable-FMV drop rule, and the ROW_CAP slice reporting the full
      //     available count) + market-feed 47.9br->~75% (the seller-concentration
      //     block, which is column-probe-gated so it was entirely dark: the
      //     >60/>40 pct thresholds, the edition-id->external-key remap, and the
      //     NON-FATAL catch that must never take the feed down). Live actual:
      //     stmts 84.77 / branch 69.69 / funcs 88.76 / lines 87.43.
      //   2026-07-25 (cont. 32): fast-break/lineup 48.4br->~85% (the whole
      //     validation ladder past the run lookup — date-outside-run, size
      //     mismatch, captain-not-in-lineup, eligibility RPC 500, the named
      //     ineligible player — plus the write outcomes incl. the 409
      //     exceeds_use_budget) and wmc-fmv-populate 42br->~75% (limit clamp,
      //     force/skip_refresh echoes, and both global-refresh error arms).
      //     FINDING recorded in that test: wmc-fmv-populate's outer "background
      //     pass crashed" catch is DEFENSIVE-ONLY — runOne try/catches both RPCs
      //     and its own log, so nothing escapes to it; do not chase it for
      //     coverage. Live actual: stmts 84.81 / branch 69.75 / funcs 88.81 /
      //     lines 87.46.
      //   2026-07-25 (cont. 33): topshot-active-listings-ingest 48.3br->~90%
      //     (upsert/deactivate/log arms — incl. the SAFETY contract that a
      //     WAF-blocked sweep logs ok:false but must NOT deactivate, or the board
      //     empties) and early-access/submit 49.4br->~70% (the after() slow
      //     on-chain re-score: wallet-search -> moment count -> auto_approve_
      //     eligible -> decision, the already-active skip, the no-count no-score
      //     rule, and the Telegram-ping lookup arms). Live actual: stmts 84.96 /
      //     branch 69.93 / funcs 88.87 / lines 87.63.
      //   2026-07-25 (cont. 34): support-chat/context 48.3br->~80% (the dailyDeal
      //     and marketPulse FALLBACK LADDERS beneath the happy path — cached_
      //     listings fallback, the 30%/20%/tracked-count tiers, the hot-mover
      //     append) and allday-wallet-search 46br->~70% (FMV enrichment via
      //     editions->fmv_snapshots, special-serial traits, username resolution,
      //     empty wallet). BRANCH COVERAGE CROSSED 70%. Gotcha worth keeping:
      //     allday-wallet-search MEMOIZES PER WALLET, so every test case needs a
      //     distinct address or it silently asserts against the first case's
      //     cached payload. Live actual: stmts 85.08 / branch 70.07 / funcs 88.96
      //     / lines 87.74.
      //   2026-07-25 (cont. 35): allday-pack-ev 47br->~60% — fetchRpcFmvMap, the
      //     lookup that OVERRIDES All Day marketplace prices with fmv_snapshots,
      //     was dark because the test's Supabase stub returned null for every
      //     table so the function hit its empty-map early returns. Now covers the
      //     real join (newest snapshot wins), all three fallbacks (no editions /
      //     no snapshots / non-positive fmv), and the non-fatal throw. Live
      //     actual: stmts 85.13 / branch 70.13 / funcs 88.99 / lines 87.78.
      //   2026-07-25 (cont. 36): the last two open low-branch routes.
      //     cache-refresh 48.6br->72.6% — Step 6b, the NON-TopShot fmv_usd denorm,
      //     was entirely dark because every existing case drove the nba-top-shot
      //     slug (which skips 6b). Now pins the editions<->fmv_snapshots join,
      //     newest-snapshot-wins, and the $10K defensive ceiling IN BOTH
      //     DIRECTIONS (over-ceiling passes only on HIGH confidence with
      //     sales_count_30d >= 3) — the guard that keeps a thin five-figure
      //     outlier off a collector's wallet page — plus fetchMomentGql's three
      //     degradation arms. cron/pinnacle-metadata-backfill 39.9br->81.5%:
      //     queues 2-4 and the whole apply phase (Q2 writes BOTH wmc and
      //     pinnacle_nft_map; Q3 corrects whichever SIDE disagrees with chain;
      //     Q4's Unknown/trim fallbacks, complete-row skip, key dedupe, and the
      //     invariant that thumbnail_url is NEVER in the upsert payload), plus
      //     the six pre-Cadence 500s and the soft-deadline break. Also cleared 8
      //     pre-existing `tsc` errors on main from the recurring mock-state
      //     `data: [] as any[]` narrowing trap. Live actual: stmts 85.41 /
      //     branch 70.45 / funcs 89.03 / lines 88.05.
      //   2026-07-25 (cont. 37): five routes re-derived off the authoritative
      //     per-file gate table (the hand-kept list had gone stale AGAIN).
      //     allday-fmv-populate 42br->84.6% — the sweep machinery: the
      //     concurrency lock (and the stale lock that must NOT hold), both
      //     stall-reset arms, pagination/stop conditions, and the DOUBLE
      //     ULTIMATE guard (fmv_snapshots ULTIMATE rows belong to
      //     recalc_ultimate_fmv alone, so this writer must never insert one —
      //     pinned including the case where the tier lookup throws and the
      //     write-site re-check is the only thing left). golazos+ufc-listings-
      //     indexer 53/51br->74.9/69.7% as a describe.each over the twins: the
      //     first-run sealed-tip anchor (a regression here walks the chain from
      //     block 0), completed-event matching, the batch-upsert -> per-row
      //     fallback, and the DUC/FUT-only price_usd rule. admin/rewards
      //     53.8br->82.5% — the "who do I ship this to?" precedence
      //     (gift_to > profile > best linked wallet) and all 8 POST arms,
      //     notably cancel_refund refusing a non-pending row (a second refund
      //     mints credits). pack-ev 51br->75.8% — the AllDay forward, every
      //     secondary-ask degradation, the cache-hit reprice, the RPC-FMV
      //     override, and the fire-and-forget history tail. Live actual:
      //     stmts 86.06 / branch 71.11 / funcs 89.43 / lines 88.65.
      //   2026-07-25 (cont. 38): the four biggest remaining uncovered-branch
      //     routes outside the closed-for-cause set. wallet-search 55.5br->64.3%
      //     — the league filter (it pages with .range() because a bare .limit()
      //     is clamped at 1,000 and a whale can own more than that in one
      //     league; on a page error it must abandon the filter, not render a
      //     false-empty wallet), the FMV play_id_onchain fallback RE-APPLYING
      //     the >$10K ceiling (a fallback that skipped it would be a hole
      //     straight through the guard), and the sales-backfill cost-basis pass.
      //     smoke-test 55.3br->70.9% — the two Pinnacle probes that catch SILENT
      //     data faults (wrong character returned / FMV borrowed across
      //     characters), incl. their soft-inconclusive transient arm and their
      //     refusal to judge when the comparison fetch hits the 1,000-row clamp;
      //     plus the SMOKE_TEST_SESSION_TOKEN opt-in probes and the top-level
      //     crash guard that must still answer 200 (the CI gate parses the body).
      //     pack-ev and the fmv-recalc sweep steps: the ?force_stale=true stale
      //     touch (re-stamps COLD editions only — touching a recently-traded one
      //     would overwrite a fresh price with a stale copy) and the 90-day
      //     widen for thin editions, which adopts the wider window only when it
      //     adds depth. Live actual: stmts 86.54 / branch 71.60 / funcs 89.92 /
      //     lines 89.13.
      //   2026-07-25 (cont. 39): the cron/*-sales-history-backfill family —
      //     ufc 55.0br->73.0%, allday 60.9->69.4%, golazos 67.6->74.6%. These
      //     four walkers are structural twins, so one edges suite ported across
      //     them covers the shared shapes at once. What it pins: the **23505
      //     row-by-row retry** on BOTH the `sales` and `unmapped_sales` batch
      //     inserts (a batch .insert() is all-or-nothing, so one duplicate
      //     fails the whole <=100-row statement — here the positive-23505
      //     branch IS the retry, the correct shape, and it must salvage every
      //     co-batched NEW row while a non-dupe error must NOT retry); the V2
      //     Dapper venue incl. AllDay's effectively-dormant arm; **?dryRun=true
      //     writing NOTHING** (no sales, no unmapped, no cursor move, no
      //     promote — a dryRun that wrote would be the worst possible bug in a
      //     backfill); and fetchEventRange's spork-floor 404 vs any other
      //     failing status. Live actual: stmts 86.82 / branch 71.91 /
      //     funcs 89.94 / lines 89.40.
      //   2026-07-25 (cont. 40): topshot-flowty-sales-history-backfill
      //     62.0br->69.4%, completing the four-walker family — the same 23505
      //     row-by-row retry (sales + unmapped_sales) and the spork-floor-404
      //     vs other-failing-status split. All four backward walkers now carry
      //     the identical edges suite, so a defect in the shared shape fails in
      //     four named places instead of hiding in whichever copy nobody drove.
      //     Live actual: stmts 86.86 / branch 71.96 / funcs 89.94 / lines 89.44.
      //   2026-07-25 (cont. 41): four PURE lib modules — the cheapest remaining
      //     coverage and the most durable, since none of them need a harness.
      //     lib/pinnacle/pinnacleTypes 46.0br->94.3% (flowtyTraitsToPinnacleEdition
      //     is the ONLY place raw Flowty trait strings become a typed edition, so
      //     each default lands on a collector's pin card — incl. the minting
      //     timestamp that arrives in SECONDS from some rows and MILLISECONDS from
      //     others; reading seconds as ms dates a 2024 pin to 1970).
      //     lib/pack-drops-board 57.7br->81.5% (fetchFlowUsd must return null,
      //     never 0/NaN, or the board renders $0.00 pack prices as real;
      //     discoverDropIds' probe FALLBACK had no test at all).
      //     lib/alerts/format 62.6br->78.0% (the two-board fallback chains behind
      //     every headline price — a broken arm still SENDS the alert, it just
      //     says "—" where a price belongs).
      //     lib/chains/flow/wallet-backfill-helpers 73.8br->77.3% (the Pinnacle
      //     runner's remaining error taxonomy — each arm decides whether a
      //     failure PAGES or is a known self-recovering condition).
      //     Live actual: stmts 87.09 / branch 72.24 / funcs 90.17 / lines 89.65.
      //   2026-07-25 (cont. 42): three more pure lib modules, all "degrade
      //     instead of throw" contracts. dapper-v1-tx-decode 72.3br->82.2%
      //     (100% funcs) — decodeTopShotSaleTxViaSpork had NO tests at all; the
      //     lane is inert until an operator deploys the worker, which is exactly
      //     why nothing else would catch a regression in it, and every failure
      //     mode must return nulls with ok:false rather than throw (a throw
      //     inside the backfill loop aborts the whole batch). concierge/
      //     pinnacle-router 70br->72.7% — the three catch arms that turn a DB
      //     outage into a {status:"error"} tool result instead of a broken chat
      //     turn, PLUS the deliberate odd-one-out: searchPinnacleByName returns
      //     a typed object and must PROPAGATE (its caller is the boundary), or
      //     the concierge reports a clean "0 results" for a DB outage.
      //     sitemap-data 72.1br->74.4% — the per-enumerator catch arms, so a
      //     malformed payload from one table costs Googlebot that table's URLs
      //     and not the whole segment. Live actual: stmts 87.16 / branch 72.29 /
      //     funcs 90.19 / lines 89.73.
      //   2026-07-25 (cont. 43): the four ZERO-coverage Cadence write templates,
      //     plus two low-statement modules. The cadence templates (gift-moment,
      //     purchase-moment, make/cancel-offer) are all on SHELVED paths, which
      //     is exactly why they had 0% and exactly why they needed a structural
      //     pin — nothing exercises them, so a bad edit sits undetected until
      //     someone revives the path and signs a real transaction with it; the
      //     test asserts Cadence 1.0 syntax (no AuthAccount/pub), the mainnet
      //     addresses CLAUDE.md enumerates, the Dapper dual-signer + DUC-leak
      //     post block, gift-moment's SINGLE signer, and that Flowty's 0.00025
      //     royalty was not copy-pasted from Top Shot's 0.05 (a 200x overcharge).
      //     lib/serial-premiums-board 46.7st->100% (every filter/sort must bind
      //     to the SELECTED board's own columns — a fallback to the other
      //     board's sale column orders the page by the wrong sale, plausibly).
      //     app/api/badges 52.6st->100%, 53.8br->95.6% (the PLAY-TAG ALLOWLIST:
      //     Top Shot mixes ~6 real badges with ~25 gameplay descriptors, so
      //     dropping the filter sprouts fake badges on every moment — the
      //     fabricated-signal class — plus all 13 mode->filter bindings asserted
      //     on BOTH the count and data queries). Live actual: stmts 87.34 /
      //     branch 72.42 / funcs 90.44 / lines 89.91.
      //   2026-07-25 (cont. 44): two write/aggregate routes. LINE COVERAGE
      //     CROSSED 90%. app/api/analytics 58.2st->100%, 39.5br->93.4% — the
      //     per-wallet portfolio rollup, whose load-bearing rule is an HONESTY
      //     one: acquisition history exists only for Top Shot, so every other
      //     collection returns `acquisition: null` rather than a row of zeros
      //     (zeros read as "this collector pulled nothing from packs", a claim
      //     we cannot make), plus clarity = HIGH+MEDIUM with an unknown
      //     confidence filed as NO_DATA so it can never inflate the score.
      //     app/api/edition-floor 60.8st->94.2%, 57.4br->86.8% — the entirely
      //     undriven PERSIST half, i.e. the half that WRITES fmv_snapshots:
      //     ULTIMATE editions are skipped (those rows belong to
      //     recalc_ultimate_fmv), only TODAY's snapshots are deleted so history
      //     accumulates, and the write is fire-and-forget/non-fatal. Live
      //     actual: stmts 87.53 / branch 72.59 / funcs 90.67 / lines 90.07.
      //   2026-07-25 (cont. 45): two per-account routes whose UNTESTED half was
      //     the deliverable. app/api/pin-list 55.1st->92.8%, 63.6br->94.5% —
      //     the txt/script download bodies ARE the product ("host your own
      //     collection"), and the bash script is handed to a collector to run
      //     against their own IPFS node, so its shape (shebang, set -euo
      //     pipefail, one idempotent `ipfs pin add` per CID) is the contract;
      //     plus the byte humanizer and the private-cache header on every
      //     format. app/api/email/subscribe 58.5st->100%, 63.6br->97.7% — the
      //     route header states a SECURITY rule ("the email is pinned to the
      //     signed-in user's account email; clients can't pass an arbitrary
      //     `email` field") that nothing tested; a body-supplied address would
      //     let a signed-in user send confirmation mail to anyone from our
      //     domain. Also the confirmation ladder, which must stay NON-FATAL:
      //     an unsent email still returns ok:true because the preferences DID
      //     save. Live actual: stmts 87.63 / branch 72.68 / funcs 90.69 /
      //     lines 90.18.
      //   2026-07-25 (cont. 46): app/api/admin/announcements 62.9st->100%,
      //     54.1br->98.4% — a PUBLIC-INTERNET webhook write endpoint whose whole
      //     job is turning arbitrary third-party JSON into exactly one
      //     well-formed row. The untested parts were the ones that decide what
      //     lands: the ?token= auth lane (a webhook platform that can't set
      //     headers uses it), and above all the DEDUPE KEY — with no
      //     external_id the route derives sha256(source|title|posted_at), so a
      //     retrying webhook must land on the SAME key or the feed duplicates.
      //     Also raw_payload capture (unknown fields preserved so a renamed
      //     field isn't silently lost, known fields NOT duplicated into it) and
      //     skipped_duplicate being reported honestly rather than as an insert.
      //     Live actual: stmts 87.69 / branch 72.76 / funcs 90.71 / lines 90.24.
      //   2026-07-26 (cont. 47): four small admin/cron routes that share one
      //     shape — sync auth, then a deferred after() body — and therefore one
      //     blind spot: their tests stopped at the 401/202, so the WORK had
      //     never run. That is the silent-run class the 06-10/06-11 dark-run
      //     incidents came from (route answers 202, cron entry stays enabled,
      //     nothing happened). refresh-error-triage 33.3st->100%,
      //     prune-pipeline-runs 56.3->100%, drain-fmv-cold-tail 56.4->100%,
      //     migrate-acquired-at 57.1->100%. Pinned: the pipeline_runs row that
      //     is now the ONLY failure signal, `p_retention_days` (NOT the
      //     spec's `p_keep_days` — a wrong arg name is a silent no-op against a
      //     SECDEF RPC), and the 06-11 fix where a slug that THROWS must not
      //     abort the drain loop before the pipeline_runs insert. Live actual:
      //     stmts 87.80 / branch 72.82 / funcs 90.83 / lines 90.36.
      //   2026-07-31 (test-coverage-analysis "do all of them, don't stop" — app/**
      //     monolith pure-helper extraction: 8 batches peeling byte-identical
      //     logic out of the un-measured page layer into lib/ [dashboard aggregate,
      //     market filters, pack-dist pull-odds + dual-price, pack-lifecycle
      //     formatters, sets filter/sort, alert-form payload, admin flowty-errors
      //     + flowty-analytics formatters/pivot], each unit-tested]. Live actual
      //     88.36 stmts / 73.83 branch / 91.19 funcs / 90.86 lines (up from
      //     88.24/73.6/90.88/90.76). Thresholds bumped ~0.5 under actual — a wider
      //     buffer than usual because concurrent same-day sessions were actively
      //     pushing (multiple push rejections observed); a tight margin would red
      //     their otherwise-green merges (lesson 47f901a1).
      //   2026-08-08 (test-coverage-analysis "do all of these" pass): GATED
      //     proxy.ts (the site-wide auth + allow-list security wall, previously
      //     measured by NEITHER gate) by adding it to the include, and drove its
      //     async proxy() dispatch chain for the first time (bypass-token /
      //     CORS-preflight / API + page rate-limit 429 / unauth→/login /
      //     allow-list cookie-cache + RPC-fail-closed + revoke-signOut). Also
      //     covered SEVEN dynamic routes that had NO test importing their module
      //     (moment/[id], public/profile/[username], public/ipfs-media/[cid] +
      //     pinnacle-image/[renderId] SSRF/size guards, the 3 analytics detail
      //     routes, admin/allow-list/[id] + feedback/[id], mcp/keys/[keyId]
      //     ownership 403). proxy.ts branch 90.6% lifted the aggregate:
      //     89.57/75.34/92.16/91.94 -> live actual 89.63 stmts / 75.54 branch /
      //     92.07 funcs / 91.99 lines (funcs dipped 0.09 from proxy.ts's 6
      //     integration-only helpers — still far above threshold). Thresholds
      //     bumped ~0.4 under actual, wider on funcs since it moved down.
      //   2026-08-11 (test-coverage analysis pass): thresholds LEFT UNCHANGED,
      //     but read the actuals with care — the DENOMINATOR grew. Adding
      //     `app/api/**/route.tsx` + `lib/**/*.tsx` to coverage.include (see the
      //     note above the include) brought ~1,777 previously-UNMEASURED
      //     branches into the gate, so actuals moved 91.65→90.83 stmts /
      //     78.76→77.28 branch even though nothing regressed and ~90 tests were
      //     ADDED. That is measurement expanding, not coverage falling — the
      //     mirror image of the documented "files left the measured set"
      //     exception, and the ONLY reason a drop here is legitimate.
      //     Post-change actuals: 90.83 st / 77.28 br / 92.11 fn / 93.02 ln
      //     (buffers +1.53 / +2.18 / +0.61 / +1.42). NOT raised: functions sits
      //     only +0.61 over, and the newly-measured OG cards contribute ~65
      //     uncovered per-card render helpers that only run on specific data
      //     branches. Raise these once those cards gain per-card data-branch
      //     tests — and as always, never lower them to make a red build pass.
      //   2026-08-11 (same session, cont.): NOW RAISED — the condition stated
      //     directly above is met. The OG cards gained per-card data-branch
      //     coverage (__tests__/api-og-cards-render-sweep.test.ts now supplies
      //     each card's real envelope shape and PROVES the data branch ran by
      //     requiring the populated render to differ from the dead-upstream
      //     one), so the ~65 uncovered render helpers largely execute. Functions
      //     — the metric left at a fragile +0.61 — went 92.11 → 92.77, and every
      //     buffer is now ≥ +1.27. Actuals: 90.98 st / 77.59 br / 92.77 fn /
      //     93.14 ln; thresholds set ~0.5 under, the margin prior waves used
      //     successfully against concurrent-push churn (lesson 47f901a1).
      //   2026-08-13 (test-coverage analysis → "do all you can"): the pack-dist
      //     page's 11 fetchers extracted to lib/pack-dist/fetchers.ts (server
      //     `page.tsx` is measured by NEITHER gate — 48,325 LOC, 79 of which
      //     query Supabase directly), the three worst-covered files in this gate
      //     given per-card data-branch tests (og/moment 21.4% br, og/edition
      //     25.5%, og/pack 36.0%), the mount-time warming sequence in
      //     lib/warmup/WarmupContext.tsx driven (37.6% br, the worst ratio here),
      //     and the 15 insights OG cards' empty-vs-unavailable split pinned.
      //     Live actual 91.50 st / 78.63 br / 93.30 fn / 93.65 ln.
      //
      //     ⚠ Thresholds set ~0.3 under actual, which is a RAISE OF ~0.9 on
      //     branch rather than the usual increment. The old numbers had drifted
      //     ~0.8–1.0 below actual because several waves added coverage additively
      //     and left the ratchet where it was. That is defensible once and wrong
      //     when repeated: a ratchet only protects the coverage it is actually
      //     set to, and this repo has already paid for the compound version —
      //     the component gate reached a ~13-POINT unguarded branch buffer before
      //     anyone noticed (see vitest.components.config.ts, 2026-08-13). The
      //     0.3 keeps the concurrent-push churn margin lesson 47f901a1 records
      //     without leaving a point of coverage dark.
      //   2026-08-15 (test-coverage "do all of these" pass): re-seated against
      //     measured actuals of 91.69 / 79.00 / 93.46 / 93.78. Branch slack had
      //     drifted to 0.70 as this pass added tests (7 DB-pin suites, the OG
      //     headline-count guard, the AllDay buyer-recovery cases, the extracted
      //     edition market fetchers) without moving the gate. That is the exact
      //     drift the component gate's history records compounding into ~13
      //     points, so it is re-seated in the SAME pass that measured it, back to
      //     the documented ~0.4 margin.
      //   2026-08-20 (test-coverage analysis pass): re-seated against measured
      //     actuals of 91.92 / 79.53 / 93.72 / 93.97 (1320 files, 14,246 tests).
      //     Three changes moved it, all UPWARD, and none of them by loosening:
      //       * `supabase/functions/_shared/**` joined the include above. Those
      //         29 modules measured 98.31 / 92.76 / 100 BEFORE widening — above
      //         the aggregate in every metric — which is the only shape of
      //         include-widening allowed here. Widening to buy headroom is the
      //         thing this comment block exists to prevent.
      //       * `lib/edition/legacy-redirect.ts` went 0% -> 100%.
      //       * `lib/pipeline/heartbeat.ts` landed already covered.
      //     Margins held at ~0.12, the documented size: big enough to survive a
      //     concurrent merge, small enough that a real drop still reds.
```

## §6 · `vitest.components.config.ts` › above `export default defineConfig({`

```text
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
```

## §7 · `vitest.components.config.ts` › above `testTimeout: 30_000,`

```text
    // ── testTimeout: 30s, raised from vitest's 5s DEFAULT (2026-08-24) ────────
    // ⚠ NOT to paper over slow tests. This repo has DOZENS of guards whose job is
    // to walk the whole tree and read every file — the honesty ratchets, the
    // completeness sweeps, the leak guards. Several sit at 1–3.5s standalone and
    // cross 5s under the FULL PARALLEL RUN's load, so WHICH ONE reds is luck:
    // measured 2026-08-24, three separate full runs each failed a DIFFERENT file
    // (worker-test-completeness at 5236ms, then no-constant-foldable-joined-
    // templates, then api-allday-listings-indexer) and every one passed in
    // isolation.
    //
    // ⚠ A guard that reds for being SLOW is indistinguishable at a glance from one
    // that FOUND something, and it trains exactly the skimming that let a real
    // failure hide in a red suite earlier the same day.
    //
    // 🚨 AND THE 5s DEFAULT WAS ACTIVELY MISLEADING, which is the stronger reason.
    // The three worker suites fixed on 2026-08-24 reported "Test timed out in
    // 5000ms" — so they read as flaky scheduling. At --testTimeout=60000 the mask
    // came off and they were ORDINARY ASSERTION FAILURES underneath, from a real
    // defect (a nested node_modules defeating vi.mock). The timeout was hiding the
    // error, not reporting one.
    //
    // The cost is stated: a genuinely HUNG test now takes 30s to fail instead of 5.
    // That is the right trade — "timeout" should mean "actually stuck", not
    // "unlucky scheduling". Full case: docs/reference/testing-and-ci.md.
```

## §8 · `vitest.components.config.ts` › above `reportsDirectory: "coverage-components",`

```text
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
```

## §9 · `vitest.components.config.ts` › above `"components/auth/**/*.tsx",`

```text
        // Added 2026-07-31 (test-coverage pass): three previously-UNMEASURED
        // logic-bearing subtrees, now gated so they can't silently rot. The new
        // __tests__/component-gate-include-completeness.test.ts rot-guard fails
        // CI if any components/<subtree> is in neither this include nor its
        // explicit allowlist. auth = the sign-out + pro-badge siblings (its
        // ConnectButton went with the 2026-08-08 wallet-sign-in removal);
        // marketplace-status = the per-collection banner/chip/pill; onboarding =
        // the first-run tour.
```

## §10 · `vitest.components.config.ts` › above `"components/legal/**/*.tsx",`

```text
        // ── 2026-08-20: the LAST four subtrees, so `components/` is now whole ──
        //
        // These were not an oversight — `component-gate-include-completeness`
        // has tracked them in `KNOWN_UNMEASURED` all along, which is the right
        // mechanism and worked exactly as designed. What went stale was the
        // REASON each carried, and a decision-not-to-act is the one nobody
        // re-checks. ⚠ Every one of the four reasons asserted inertness with no
        // number in it — this repo's documented tell:
        //
        //   legal   "variant/link toggles only, no logic" — the toggles ARE the
        //           logic: `showMethodologyLink={false}` sits one careless edit
        //           from dropping the "not investment advice" disclosure along
        //           with the link, on a platform whose product is a price.
        //   play    "presentational hub shell (links only)" — whether a card is
        //           a LINK AT ALL depends on `live`, which must agree with an
        //           unconditional `redirect()` in a DIFFERENT file's layout.tsx.
        //           Both ways of disagreeing ship a defect, and nothing checked
        //           it. "Links only" is precisely what made it look inert.
        //   ui      "generic presentational primitives (no branches)" — literally
        //           false: LoadingState has a defaulted prop, a modulo'd width
        //           cycle and an opacity ramp.
        //   visual  "decorative visual chrome" — ConsoleGreeting carries a
        //           module-level once-latch (React 19 StrictMode double-invokes
        //           effects) and the repo's ONE sanctioned hardcode of #E03A2F.
        //
        // Tests landed in the same commit (component-PlayHub,
        // component-FmvDisclaimer, component-visual-and-loading), so this RAISES
        // the gate rather than buying headroom. Their KNOWN_UNMEASURED entries
        // are deleted in the same commit — the rot guard's "no stale entries"
        // case enforces that, which is why the bookkeeping cannot drift.
        //
        // ⚠ This does NOT make the include a tree walk. `components/*.tsx` plus
        // named subtrees still means a NEW subtree matches nothing; that is what
        // the rot guard is for, and it stays load-bearing.
```

## §11 · `vitest.components.config.ts` › above `"app/**/*Client.tsx",`

```text
        // app/insights/**/*Client.tsx — the public /insights board CLIENT bodies
        // (top-sales, deals, market, offer-spread, …). ~23 files / ~12.6k lines
        // of financial display + sort/filter logic that lived under app/ where
        // NEITHER coverage gate measured them (the primary gate is lib/** +
        // app/api/**/route.ts; this gate was components/** only). Scoped to
        // *Client.tsx so the async server page.tsx wrappers — which can't be
        // cleanly rendered in jsdom — don't drown the signal. Added 2026-07-31.
        // ⚠ ONE blanket glob for every client component under app/, NOT a list
        // of per-directory globs. `app/(collections)/**/*Client.tsx` matches
        // NOTHING: Next.js route groups are parenthesised, and picomatch reads
        // `(...)` as an extglob group. It fails SILENTLY — the config looks
        // right, vitest reports no error, and the file simply never enters the
        // measured set. Verified 2026-08-11: that glob returned false for
        // app/(collections)/[collection]/pack/[id]/PackLifecycleClient.tsx while
        // `app/**/*Client.tsx` returned true. (Dynamic segments like
        // `[collection]` are the same hazard — `[...]` is a character class —
        // though `**` absorbs them.) Escaping works but is easy to get wrong on
        // the next edit, so prefer the blanket glob and keep every matched file
        // tested.
        //
        // Currently matches: the ~24 insights board clients, ProfileClient (the
        // public collector profile), PackLifecycleClient (the public pack page)
        // and ErrorTriageClient (the admin triage console's auth gate).
```

## §12 · `vitest.components.config.ts` › above `thresholds: {`

```text
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
      //   2026-07-28 (cont.2): covered analytics/LenderPerformanceTable (realized-
      //     yield leaderboard: fmtUsd/fmtNumber/fmtPct + the yieldClass green/red/
      //     flat and defaultRateClass >=20 red / >=10 amber / else muted RISK
      //     ladders that are the table's judgement, + null->— and the collections-
      //     prop re-fetch / non-ok degrade). Live actual (All files): 33.17 stmts /
      //     29.33 branch / 31.56 funcs / 34.13 lines. Bumped ~0.3 under.
      //   2026-07-28 (cont.3 — prop-driven analytics/sniper components): exported
      //     + unit-tested VolumeChart's pivot data-shaper (sums principal per
      //     date+collection into the stacked series/total — a bug there mis-plots
      //     every point) and its fmtUsd/fmtDateShort/colorFor; EditionGrid's
      //     formatUsd ("No FMV" not a fake $0) / formatCirculation ("—" not a fake
      //     0-supply); and SniperFilterBar's control->callback WIRING + the
      //     per-collection visibility rules (All Day hides discount/badges/owned,
      //     Pinnacle relabels Player->Character). Live actual (All files): 35.12
      //     stmts / 31.38 branch / 33.37 funcs / 36.08 lines. Bumped ~0.3 under.
      //   2026-07-28 (cont.4 — entity heroes + activity + dashboard formatters):
      //     TeamHero (full render — the branded/fallback split + the gameLabel
      //     next-game copy Beat/Lost-to/Plays/Last decided by score+status, only
      //     reachable through the rendered GameChip, + the NBA CDN logo URL + the
      //     follow-control gating); EditionActivity (Sales|Offers toggle + the
      //     Offers honesty rule: an edition offer has NO serial → em-dash not
      //     "#0", + empty-state never errors); and the exported pure helpers of
      //     two otherwise-untested components — PacksDashboard's fmt* (null → "—",
      //     never a fake $0) and PopularOnCollection's distinctSlugLinks (SEO
      //     dedupe/cap/href). Live actual (All files): 36.6 stmts / 33.04 branch /
      //     34.67 funcs / 37.54 lines. Bumped ~0.3 under.
      //   2026-07-28 (cont.5 — the six big analytics dashboards): render tests for
      //     Sales/Fmv/Loans/Listings/Sets/PulseDashboard driving each one's OWN
      //     code — the multi-endpoint fetch orchestration (Promise.all / separate
      //     useEffects), the loading + soft-fail(catch) state machine, the
      //     window/collection re-fetch, and the inline empty states — with child
      //     components stubbed to markers. Their numeric logic already lives
      //     (tested) in lib/analytics-*-compute; this covers the previously-dark
      //     JSX/fetch-wiring bulk of six 330–740-line files. Live actual (All
      //     files): 43.15 stmts / 37.07 branch / 42.23 funcs / 44.8 lines. Bumped
      //     ~0.3 under.
      //   2026-07-28 (cont.6): EditionsGridPaginated (the reusable Load-more pager
      //     — append page / advance offset / exhaust on short-page-or-error, empty
      //     state, sort toggle); ShareProfileButtons (the UTM+&ref profile URL,
      //     X-intent open, clipboard copy + "Copied!", and the rewards-track note);
      //     + exported WalletsHubOverview's fmt helpers (null→$0/0). Live actual
      //     (All files): 44.95 stmts / 38.48 branch / 43.66 funcs / 46.68 lines.
      //     Bumped ~0.3 under.
      //   2026-07-28 (test-coverage-analysis "proceed with all", Batch 2): the
      //     three top-level market fetch-dashboards that had no test —
      //     WhaleWatch7d (fmtCurrency banding + truncAddr-vs-@username + the
      //     collection filter that re-fetches ?slug= AND hides the Collection
      //     column), HotEditions24h (null player/set/tier → "—", thrown-fetch
      //     degrade), and MarketSummary (the single market-overview-view
      //     telemetry beacon, the $0 fmtCurrency special case, present-only tile
      //     rendering). Live actual (All files): 47.13 stmts / 40.15 branch /
      //     45.83 funcs / 48.96 lines. Bumped ~0.3 under actual.
      //   2026-07-28 (test-coverage-analysis "proceed with all", Batch 3): two
      //     more untested live surfaces — PortfolioChart (the owner-key gate that
      //     renders NOTHING until a key is set, the /api/portfolio/history fetch,
      //     and the header change summary green/red/±% a collector reads at a
      //     glance; recharts stubbed to markers) and profile/WatchlistCard (the
      //     list + count badge + null-safe Ask/FMV/Target cells + Below-Target
      //     chip + the optimistic Remove that DELETEs then drops the row). Live
      //     actual (All files): 48.21 st / 41.24 br / 47.05 fn / 50.08 ln (line
      //     coverage crossed 50%). Bumped ~0.3 under actual.
      //   2026-07-28 (test-coverage-analysis "keep going", Batch 5): two more
      //     untested live surfaces — DealWatchCapture (the anon /share email
      //     capture: the client-side no-"@" gate that must NOT hit the network,
      //     the /api/subscribe POST payload contract + the email_capture_submitted
      //     funnel beacon + inbox-confirmation state, and the server/network error
      //     legs) and profile/PriceAlertsCard (fetch → list/empty/error, null
      //     player fallback, the Pause PATCH toggle, and the Delete confirm→DELETE
      //     →drop-row). Live actual (All files): 49.43 st / 42.1 br / 48.02 fn /
      //     51.39 ln. Bumped ~0.3 under actual.
      //   2026-07-28 (test-coverage-analysis "go through those", Batch 6): the two
      //     biggest logic-bearing untested components — packs/WalletPacksView (the
      //     collection-scoped pack P&L body: wallet-resolution gate → CTA, the
      //     401/403 sign-in branch, the summary hero + history table with has_buy/
      //     sell/rip "—" gating, the Unopened/Opened/Sold sub-filter re-fetching
      //     the mapped p_status, empty/error legs) and entity/TeamChecklist (the
      //     public priced checklist: anonymous SEO render + cost-to-complete +
      //     tier breakdown, the 0x-16-hex wallet-paste validation, a valid paste
      //     flipping to Owned N/M + localStorage persist, the scope-tab re-fetch;
      //     tracked cases keep wallet_cached:true so the index-warm poll timer
      //     never arms). Live actual (All files): 52.57 st / 44.5 br / 50.16 fn /
      //     54.67 ln (functions crossed 50%). Bumped ~0.3 under actual.
      //   2026-07-28 (test-coverage-analysis "go through those", Batch 7): the two
      //     remaining big untested components — TrophySlab (the ~835-line trophy-
      //     case slab: loading/empty/filled state machine, owner-vs-public empty
      //     affordance, the financial footer FMV + serial-FMV #1/perfect premium +
      //     ACQUIRED/PACK PULL/MINTED, and the owner-only remove control; prop-
      //     driven, badge-taxonomy hook stubbed to stay fetch-free) and SupportChat
      //     (the AI concierge widget: FAB open/close, the send flow — track beacon
      //     → POST /api/support-chat → render the reply on the non-stream JSON
      //     path — the 429 rate-limit break, and the empty-message no-send guard).
      //     Live actual (All files): 55.41 st / 47.43 br / 52.74 fn / 57.59 ln.
      //     Bumped ~0.3 under actual.
      //   2026-07-28 (test-coverage-analysis "go through those", Batch 8): the last
      //     named component — HomePageMarketing (the ~669-line anon landing, mostly
      //     presentational): a light render pinning the home_view funnel beacon on
      //     mount, the <h1>, the WebSite JSON-LD block, a card per published
      //     collection, and the header sign-in CTA's signin_click beacon (heavy
      //     children stubbed to markers). Live actual (All files): 55.74 st /
      //     47.51 br / 53.39 fn / 57.97 ln. Bumped ~0.3 under actual.
      //   2026-07-28 (test-coverage-analysis "proceed with all", Batch 9): the next
      //     tier of untested logic-bearing components — collection/
      //     WalletSoldMomentsView (the "Sold" body: wallet gate → CTA, 401/403
      //     verify branch, sold count + proceeds + the client-side collection
      //     filter, empty/error), analytics/RecentWhaleTrades (top-moves fetch:
      //     loading skeleton → empty → list with $M/$k banding + collection label
      //     + null fallbacks + tier chip), and profile/EmailDigestSubscribe (the
      //     email gate with no-network, the /api/subscribe payload incl. the four
      //     digest toggles, success + server-error). Live actual (All files):
      //     57.83 st / 49.25 br / 54.81 fn / 60.23 ln (lines crossed 60%). Bumped
      //     ~0.3 under actual.
      //   2026-07-28 (test-coverage-analysis "proceed with all", Batch 10): three
      //     more chart/aggregate components — profile/PortfolioSparkline (the 30d
      //     sparkline math: points build from history + a live "today" point, the
      //     <2-point empty state, the 30D-change readout + onChange(pct) callback,
      //     and a real SVG path), analytics/CrossCollectionHoldingsCard (the
      //     0x-input short-circuit, /api/public/profile → bucket-by-collection →
      //     UUID→label chips sorted desc, missing-profile null render), and
      //     profile/AchievementsCard (skeleton, unlocked-count badge + an earned
      //     achievement's progressHint, the Refresh POST). Live actual (All files):
      //     60.01 st / 50.5 br / 57.01 fn / 62.45 ln (statements crossed 60%,
      //     branches 50%). Bumped ~0.3 under actual.
      //   2026-07-28 (test-coverage-analysis "proceed with all", Batch 11): four
      //     small logic components — analytics/SalesHistoryCard (fetch → buy/sell
      //     table + null-safe cells + note, null-render on missing/empty/non-ok),
      //     collection/EditionRecentSales (no-editionKey short-circuit, loading,
      //     serial+price rows, no-sales), collection/CollectionFilterBar (each
      //     select/input dispatches SET with its field, "all" relabelling, the
      //     Top-Shot-only league filter), and entity/TeamActivity (empty, Recent
      //     sales list, and the price-sorted Biggest column dropping non-positive).
      //     Live actual (All files): 61.1 st / 51.66 br / 58.82 fn / 63.47 ln.
      //     Bumped ~0.3 under actual.
      //   2026-07-28 (test-coverage-analysis "proceed with all", Batch 12): three
      //     more logic components — analytics/HeldTimeDistributionCard (fetch →
      //     bucket bar chart, the Top-Shot-only acquisition_data_unavailable
      //     message, null-render on missing/non-ok/zero-total; recharts stubbed),
      //     entity/TeamSets (initial no-wallet EDITIONS list, empty state, and the
      //     localStorage-wallet refetch → "owned / editions" + OWNED), and
      //     SignInWithDapper (the run() auth flow: the Dapper-custodied no-addr
      //     guidance, the happy link path → onSuccess + rpc_owner_key persist +
      //     account-proof POST, and verify-failure → error + fcl.unauthenticate;
      //     fcl/fcl-config/supabase-client stubbed, window.location.reload no-op'd).
      //     Live actual (All files): 62.5 st / 52.83 br / 59.66 fn / 64.95 ln.
      //     Bumped ~0.3 under actual.
      //   2026-07-28 (test-coverage-analysis "proceed with all", Batch 13): the
      //     last three logic components — collection/CollectionSortBar (sort
      //     buttons → toggleSort + active ↑/↓, quick-filter toggles → SET negated,
      //     gated CSV/debug controls), WalletPreloader (the render-null cache
      //     gate: no-key/non-0x/fresh-cache skip the fetch, stale/missing →
      //     /api/owned-flow-ids + cache write; AbortSignal.timeout stubbed so its
      //     15s timer can't leak into a later file), and SupportChatConnected (the
      //     wiring wrapper: pathname → collectionId/pageContext, /api/profile/me
      //     identity → username-preferred ownerKey + signed-in label passed to a
      //     stubbed SupportChat). Live actual (All files): 63.51 st / 53.64 br /
      //     60.76 fn / 66.09 ln (functions crossed 60%). Bumped ~0.3 under actual.
      //   2026-07-31 (test-coverage-analysis "do everything" — SCOPE EXPANSION):
      //     added app/insights/**/*Client.tsx to the include (the ~23 public
      //     /insights board CLIENT bodies, ~12.6k lines, previously measured by
      //     NEITHER gate). Covered the four biggest with detailed render tests
      //     (TopSales/Deals/OfferSpread/Market — SaleRow loop, money formatters,
      //     empty state, sort re-fetch) and the remaining ~17 with an empty-render
      //     smoke sweep (component body + build helpers + empty branch). The
      //     aggregate DROPPED 63.5/53.6/60.8/66.1 -> live actual 59.75 stmts /
      //     49.34 branch / 56.43 funcs / 62.96 lines — this is the expected
      //     re-baseline from measuring ~12.6k previously-invisible lines, NOT a
      //     regression; the four detailed tests + smoke sweep raised the insights
      //     subtree well above zero. Thresholds reset ~0.35 under the new actual.
      //     A future untested insights client now DROPS this number and reds CI
      //     (the gate working). Raise as those clients gain per-row tests.
      //   2026-07-31 (cont. — the four biggest 0%-coverage components in the
      //     gate): PackPageClient (~677L packs feature client, 0->covered: the
      //     dual-price/calibrated-EV toPackRow mapping + the warm-cache
      //     data/loading/error state machine + Standard<->Grails toggle),
      //     TrophyPickerModal (~940L pin picker, 0->covered: top-moments fetch +
      //     grid/manual tabs + empty states + close), InsiderSignals top-level
      //     widget (0->covered: severity list + expand-to-evidence + empty/error)
      //     and MobileNav (0->covered: tab bar + Collections sheet open/close).
      //     ~378 previously-uncovered statements. Aggregate 59.75/49.34/56.43/
      //     62.96 -> live actual 62.9 stmts / 52.29 branch / 59.1 funcs / 66.52
      //     lines. Thresholds bumped ~0.35 under.
      //   2026-07-31 (cont. — populated-row tests for the biggest smoke-only
      //     insights boards): SerialPremiums / UnderpricedSerials / Squeeze /
      //     RookieBoard rendered with one populated row so the per-row cell
      //     mapping + premium/discount/squeeze formatters execute (the smoke
      //     sweep only hit the empty branch). Aggregate 62.9/52.29/59.1/66.52 ->
      //     live actual 64.9 stmts / 53.8 branch / 61.86 funcs / 68.51 lines.
      //     Thresholds bumped ~0.35 under.
      //   2026-07-31 (cont. — two more low-coverage in-gate components driven to
      //     their render layer): PacksDashboard (21%->render covered: the
      //     3-endpoint summary/top-ev/fresh Promise.all fan-out + KPI aggregation
      //     + both table empty states) and BadgeRow (render covered: priority
      //     sort + visible/hidden cap + "+N" expand + null-on-empty; taxonomy hook
      //     mocked). Aggregate 64.9/53.8/61.86/68.51 -> live actual 66.23 stmts /
      //     54.88 branch / 63.35 funcs / 69.97 lines. Thresholds bumped ~0.35.
      //   2026-07-31 (cont. — three more 0%-coverage components knocked out):
      //     TeamFollowButton (follow-status state machine + POST/DELETE toggle),
      //     components/analytics/CostBasisCard (P&L card + the missing/reason/
      //     zero-tracked null-guards; distinct from the tested profile/ one), and
      //     WalletHydrator (headless localStorage->/-api/wallet/profile backfill:
      //     no-key short-circuit, backfill path, fresh-TTL skip). Aggregate
      //     66.23/54.88/63.35/69.97 -> live actual 67.22 stmts / 55.71 branch /
      //     64.03 funcs / 71.02 lines. Thresholds bumped ~0.35.
      //   2026-07-31 (cont. — populated rows for two more smoke-only insights
      //     boards): Trophies (1-of-1 trophy row) + FirstMint (mint-#1 premium
      //     row). Aggregate 67.22/55.71/64.03/71.02 -> live actual 67.59 stmts /
      //     56.11 branch / 64.57 funcs / 71.34 lines. Thresholds bumped ~0.35.
      //   2026-07-31 (cont. — the concierge streaming path): SupportChat's
      //     STREAMING branch (the ReadableStream reader loop, the \x1e record
      //     separator splitting streamed text from trailing meta JSON, the meta
      //     application — dbId/escalated/momentCards, the connection-error catch,
      //     and the rpc-concierge-ask window event) driven for the first time —
      //     SupportChat 45.6%->68.2% st. Aggregate 67.59/56.11/64.57/71.34 ->
      //     live actual 68.26 stmts / 56.55 branch / 65.34 funcs / 71.9 lines.
      //     Thresholds bumped ~0.35.
      //   2026-07-31 (cont. — CollectionMomentTable mobile expanded panel): the
      //     desktop table + a desktop-expanded row were covered; the MOBILE
      //     expanded card sub-sections (FMV/Low-Ask/Cost-&-P&L rows over a real
      //     cost-basis entry incl. the loan-default label, + the recent-sales
      //     section mounting EditionRecentSales) were dark. Aggregate 68.26/56.55/
      //     65.34/71.9 -> live actual 68.39 stmts / 56.87 branch / 65.47 funcs /
      //     72.05 lines. Thresholds bumped ~0.3.
      //   2026-07-31 (cont. — last two initialRows-based insights boards):
      //     ParallelPremiums (base-vs-parallel premium row) + PinnacleScarcity
      //     (character-keyed chaser scarcity row) populated-row tests, completing
      //     the insights populated pass. Aggregate 68.39/56.87/65.47/72.05 ->
      //     live actual 68.73 stmts / 57.22 branch / 65.97 funcs / 72.39 lines.
      //     Thresholds bumped ~0.3.
      //   2026-07-31 (cont. — three newly-GATED subtrees, auth + marketplace-
      //     status + onboarding, added to the include above with fresh test
      //     suites; auth 91.5% st, onboarding 82.7%, marketplace-status covered):
      //     aggregate 68.73/57.22/65.97/72.39 -> live actual 69.14 stmts /
      //     57.43 branch / 66.4 funcs / 72.74 lines. Thresholds bumped ~0.3 under.
      //   2026-07-31 (cont. — five previously-untested top-level components/*.tsx,
      //     all with real branch logic: PaywallModal (open/Escape/backdrop/close),
      //     CollectionSwitcher (page-type derive + per-collection supportsPage
      //     gate), ThemeToggle (light/dark attribute+localStorage flip), RefCapture
      //     (?ref uuid validate + first-touch stash), AnonSignInPill (anon-only
      //     CTA + ?next)): aggregate 69.14/57.43/66.4/72.74 -> live actual 70.04
      //     stmts / 57.95 branch / 67.15 funcs / 73.73 lines. Bumped ~0.3 under.
      //   2026-07-31 (cont. — ExplainButton (rpc-concierge-ask CustomEvent) +
      //     FunnelTracker (mount beacon + dedup + perPath)): live actual 70.21
      //     stmts / 58.04 branch / 67.28 funcs / 73.93 lines. Bumped ~0.3 under.
      //   2026-07-31 (cont. — TelemetryPageView (page-view beacon + skip-prefix
      //     guard)): live actual 70.33 stmts / 58.08 branch / 67.42 funcs / 74.05
      //     lines. Bumped ~0.3 under.
      //   2026-07-31 (cont. — MomentHeroMedia: the ordered image-candidate
      //     fallback state machine + video-error-hides-to-reveal-image, the guard
      //     against the ~30% blank-hero legacy-edition regression): live actual
      //     70.51 stmts / 58.26 branch / 67.59 funcs / 74.25 lines. Bumped ~0.3.
      //   2026-08-01 (KNOWN_UNMEASURED audit — GATE two mis-allowlisted subtrees):
      //     added components/pricing + components/filters to the include (they were
      //     allowlisted as "static/presentational" but carry real branch logic) and
      //     covered them — StripeSubscribeButton (the paid-conversion fetch state
      //     machine: 401→login / url→checkout / !ok error / thrown-fetch error,
      //     100% st) and LeagueFilter (visible gate + active-toggle + fire-only-on-
      //     change). Net UP despite the new files. Live actual 70.62 stmts / 58.35
      //     branch / 67.64 funcs / 74.36 lines. Bumped ~0.3 under.
      //   2026-07-31 (test-coverage "do all of them, don't stop" — component spot-
      //     fills: FeatureTabGate route-gate, AnalyticsSidebar isActive nav, insights
      //     FreshnessStamp hydration guard, collection AutoSearchReader URL-param
      //     precedence). Live actual 71.22 stmts / 58.78 branch / 68.3 funcs / 75.01
      //     lines. Bumped modestly to lock; ~0.3 buffer for concurrent churn.
      //   2026-08-01 (test-coverage "do everything" — insights populated-row tranche 2):
      //     the nine LOWEST-coverage smoke-only /insights board clients got
      //     populated-row render tests so their per-row cell mapping + money/count/
      //     percent formatters execute for the first time (the smoke sweep only hit
      //     the empty branch) — MarketPulse 21%, PackDrops 30%, AllDayScarcity 37%,
      //     SetSqueeze 39%, NewCollectors 42%, SetCompleters 43%, CrossCollection
      //     44%, PackSniper 47%, Rookies 48%. Live actual 73.56 stmts / 61.18 branch
      //     / 71.35 funcs / 77.48 lines. Thresholds bumped ~0.3 under actual.
      //   2026-08-01 (cont. — insights board INTERACTION coverage): the window/sort
      //     controls the populated pass left dark. MarketPulse's 24h/7d/30d toggle
      //     is a pure client re-sort (pick() has a per-window branch; only 7d has
      //     sellers); Rookies/AllDayScarcity/SetSqueeze re-run their fetch effect on
      //     a sort change (skip-first-run guard means the default came from
      //     initialRows) — drove each effect's success leg. Live actual 74.11 stmts
      //     / 61.35 branch / 71.75 funcs / 78.07 lines. Thresholds bumped ~0.3 under.
      //   2026-08-01 (cont. — CandyBoardClient remaining tabs + Market controls):
      //     the existing CandyBoard test drove Market/Deals/Serials; added the four
      //     dark tab branches (Spread/Scarcity/Holders/Players — incl. the Core-vs-
      //     Rainbow premium-multiple rollup and each DataTable empty state) plus the
      //     Market tab's client-side controls (column-sort toggle, Rainbows tier
      //     filter, player search). Live actual 74.7 stmts / 61.93 branch / 73.35
      //     funcs / 78.68 lines. Thresholds bumped ~0.3 under.
      //   2026-08-01 (cont. — SqueezeBoardClient client-side filters): the populated
      //     pass rendered only the default view; drove the tier / max-effectively-
      //     buyable / max-circulation pills, each a branch of the client-side
      //     `filtered` useMemo (the buttons never refetch). Live actual 74.82 stmts /
      //     62.06 branch / 73.52 funcs / 78.77 lines. Thresholds bumped ~0.3 under.
      //   2026-08-01 (test-coverage "do all you can" — insights-gate blind spot):
      //     three PUBLIC /insights surfaces are CLIENT page.tsx files
      //     (squeeze-check / tc-report / pack-reality), not the *Client.tsx
      //     convention, so the app/insights/**/*Client.tsx glob missed them and
      //     they sat under app/ measured by NEITHER gate despite real wallet-paste
      //     + fetch + row-mapping logic. Added the three by explicit path to the
      //     include + render tests (form submit → summary/report/board render,
      //     malformed-wallet no-network guard, non-ok error, ?wallet= auto-load,
      //     mount-fetch loading/failed states) + a NEW insights-gate-include-
      //     completeness rot-guard so a future client insights page.tsx can't
      //     silently rot. Live actual 74.9 stmts / 61.87 branch / 73.83 funcs /
      //     78.97 lines. Thresholds bumped ~0.3 under.
      //   2026-08-08 (test-coverage-analysis "do all of these" pass): drove the
      //     INTERACTION + per-row branch layer of the two lowest-branch insights
      //     clients — PinnacleScarcity (43.6% br) + SerialPremiums (47.2% br) —
      //     which the smoke/populated passes left dark: the filter-pill / sort /
      //     tab toggles that REFETCH, the money/percent/multiple formatter bands,
      //     the tier-color ladder, and per-row conditional cells (chaser chip,
      //     conflation badge, null "—" fallbacks, PremiumImage onError → thumb →
      //     gradient). Aggregate 76.3/63.99/76.03/80.31 -> live actual 77.24
      //     stmts / 64.81 branch / 76.76 funcs / 81.23 lines. Thresholds bumped
      //     ~0.4 under actual.
      //   2026-08-08 (cont. — second insights interaction batch): four more of
      //     the lowest-branch board clients across both models — RookieBoard +
      //     SetCompleters (PURE client-side view/tier/parallel/sort filters +
      //     grouping memos), OfferSpread + ParallelPremiums (REFETCH on tier /
      //     ≥floor / confidence / parallel-chip / sort + error state). Aggregate
      //     77.24/64.81/76.76/81.23 -> live actual 78.19 stmts / 65.63 branch /
      //     77.91 funcs / 82.09 lines. Thresholds bumped ~0.4 under actual.
      //   2026-08-08 (cont. — entity/pack component gaps): PlayersGridPaginated
      //     (36% br, NO prior test — the entity-page player grid: Current/All-Time
      //     roster toggle incl. the no-active-data guard, FMV/Editions/A→Z sort,
      //     Load-more append → exhaust-on-short-page + exhaust-on-error, headshot→
      //     portrait→"No image" fallback, rookie badge) + PackTable's DualPriceCell
      //     (the em-dash-not-$0.00 honesty rule + primary→live-secondary precedence)
      //     and PackThumb onError fallback (both untested by the existing PackTable
      //     suite). Aggregate 78.19/65.63/77.91/82.09 -> live actual 78.54 stmts /
      //     66.14 branch / 78.27 funcs / 82.44 lines. Thresholds bumped ~0.4 under.
      //   2026-08-08 (cont. — insights batch 3 + AnonSignInPill): Trophies
      //     (collection/type/sort refetch + error) + UnderpricedSerials (headline/
      //     tier/quality/sort refetch + the coarse "~%" discount branch) interaction
      //     coverage, and AnonSignInPill (the anon-only /login?next= pill: render-
      //     nothing-until-known, signed-in→null, sign-out event flip, no-pathname
      //     ?next omission). Aggregate 78.54/66.14/78.27/82.44 -> live actual 79.24
      //     stmts / 66.52 branch / 78.87 funcs / 83.2 lines. Thresholds bumped ~0.4.
      //   2026-08-08 (cont. — MomentDetailModal financial cells + provenance):
      //     extended the existing MomentDetailModal suite (had a11y/CTA/ASK_ONLY
      //     only) with the dark branches — the dapper.market link, serial/mint/
      //     fmv/listing/best-offer cells + their null omissions (best-offer 0 must
      //     not render $0.00), the deal-rating colour bands, badges, and the
      //     loan-default provenance block (truncated source wallet + USDC
      //     principal). Aggregate 79.24/66.52/78.87/83.2 -> live actual 79.29
      //     stmts / 66.75 branch / 78.96 funcs / 83.26 lines. Thresholds bumped.
      //   2026-08-08 (cont. — WalletProfile lending-card branches): extended the
      //     existing suite (role/limbo/counterparty only) with the Copy-address
      //     clipboard flow, the statusBadge ladder (Active/Repaid/Settled/
      //     Cancelled/unknown passthrough), the click-to-expand loan-detail panel
      //     + counterparty drill-down link, and the limbo-only Mixed-role panels.
      //     Aggregate 79.29/66.75/78.96/83.26 -> live actual 79.43 stmts / 66.91
      //     branch / 79.05 funcs / 83.42 lines. Thresholds bumped ~0.4 under.
      //   2026-08-08 (wallet-sign-in REMOVAL — a DENOMINATOR change, not a
      //     regression): RPC no longer offers any wallet sign-in (Trevor), so
      //     components/SignInWithDapper.tsx and components/auth/ConnectButton.tsx
      //     were DELETED along with their suites. Both were well-covered, so
      //     removing them lowers the aggregate even though no surviving file lost
      //     a single covered line — branch coverage actually ROSE (66.91 -> 66.64
      //     is on a different denominator; the deleted files were branch-light and
      //     statement-heavy). Live actual after removal: 78.83 stmts / 66.64
      //     branch / 78.45 funcs / 82.82 lines. Re-baselined ~0.2 under actual.
      //     This is the ONE legitimate reason to move a ratchet down — files left
      //     the measured set. Never lower these to make a red build pass.
      //   2026-08-09 (insights board-client coverage wave): dedicated tests for
      //     the four previously-UNTESTED /insights board clients —
      //     PackSniperClient (949 LOC, was 44.7% br), FirstMintBoardClient,
      //     PackDropsBoardClient, UnderpricedSerialsBoardClient — driving their
      //     filter pills / refetch params / sort / pause / error states. Live
      //     actual 79.91 stmts / 67.74 branch / 79.43 funcs / 83.83 lines.
      //     Raised ~0.7-0.9 under actual to lock in the floor while keeping a
      //     concurrent-churn buffer.
      //   2026-08-11 (test-coverage analysis pass): RATCHETED UP to close a
      //     gate that had stopped gating. Measured actuals were 89.95 st /
      //     80.90 br / 89.65 fn / 93.08 ln against thresholds of
      //     79.0/67.0/78.8/83.2 — a ~13-POINT branch buffer, meaning a large
      //     real regression would have passed CI silently. The buffer had grown
      //     that wide because several waves raised coverage additively and left
      //     the thresholds alone ("keep the concurrent-churn buffer"), which is
      //     right once and wrong when repeated: the ratchet only protects the
      //     coverage it is actually set to. New thresholds keep a deliberate
      //     ~1.4pt margin — enough for the concurrent-push churn that lesson
      //     47f901a1 records, without leaving 13 points unguarded.
      //     This wave also added __tests__/component-insights-client-pages-deep
      //     (tc-report + pack-reality were the two weakest gated files at 55.1%
      //     and 51.7% branches — both PUBLIC wallet-paste tools whose money/
      //     date formatter ladders were entirely dark).
      //   2026-08-15 (test-coverage "do all of these" pass): tightened the
      //     margin. Measured actuals 90.21 st / 81.74 br / 89.00 fn / 93.10 ln
      //     against 88.5/79.4/88.2/91.6 — a 2.34pt branch buffer, drifting the
      //     same direction as the ~13pt incident above rather than being a
      //     regression in its own right. No coverage was ADDED to this gate by
      //     that pass; this is purely re-seating the ratchet under the actuals
      //     it is meant to protect. New margins are ~0.4-0.5pt, matching the
      //     primary gate's, which is enough for concurrent-push churn (lesson
      //     47f901a1) without leaving points unguarded. The rule this encodes:
      //     re-seat the ratchet in the SAME pass that measures a drift, because
      //     "keep the buffer" is exactly how the 13pt version accumulated.
      //   2026-08-15 (0%-coverage component wave, SAME DAY as the re-seat
      //     above): raised again because this wave really did ADD coverage —
      //     six gated components were sitting at 0% STATEMENTS, i.e. never
      //     rendered by any test while still counting against this gate:
      //     ProBadge, GlobalSiteHeader, SiteFooter, TeamLogo, ExploreSection
      //     and SniperThumbnailPreview. Actuals moved 90.21/81.74/89.00/93.10
      //     -> 90.72/82.08/89.55/93.68. Same ~0.4pt margin held.
      //     ⚠ ProBadge is the one worth remembering: it carries an 11-line
      //     comment describing the site-wide silent failure it narrowly avoided
      //     (keyed on fcl.currentUser, permanently signed-out since the
      //     2026-08-08 wallet-connect removal => every Pro and Founding badge
      //     renders null, tsc green). Nothing pinned that fix. Verified by
      //     mutation: re-keying it onto a null identity passed tsc AND the full
      //     11,958-test suite. A near-miss earning a comment instead of a test
      //     is the shape to watch for.
      //   2026-08-20 (test-coverage analysis pass): re-seated against measured
      //     actuals of 90.75 / 81.93 / 89.31 / 93.65 (239 files, 2,962 tests),
      //     after the last four `components/` subtrees (legal, play, ui, visual)
      //     joined the include above WITH their tests, taking the gate from 215
      //     measured files to 220. Every metric rose.
      //
      //     ⚠ `functions` DELIBERATELY LEFT AT 89.1 rather than raised to ~89.2.
      //     This is the exact metric whose ±0.1pt wobble on an UNCHANGED tree is
      //     recorded in `testing-and-ci.md` — three runs measured 89.10 / 89.13 /
      //     89.20, the low sample clearing by 0.004pt. One source of that was
      //     found and fixed (`CollectionTabClient`'s intermittently-vacuous Load
      //     More case) but explicitly NOT proven to be the only one. Raising to
      //     within 0.11 of the live value would rebuild that flake by hand, and
      //     the flake fails on somebody ELSE's commit. The rule here is never to
      //     LOWER a threshold; it does not oblige raising one to the maximum the
      //     current sample allows. Raise it once the spread is known, not once a
      //     single run permits it.
      //   2026-08-20 (later, same day): re-seated again after
      //     components/entity/PopularOnCollection went 31.5 -> 100 st, 34.9 ->
      //     97.7 br, 7.7 -> 100 fn. It had been the worst-covered file in the
      //     gate by a wide margin, held there by a STALE PREMISE rather than by
      //     difficulty: both its test files opened by asserting the async server
      //     component "CANNOT be rendered in jsdom". True when written; the two
      //     reads moved into lib/entity/popular-on-collection-fetchers on
      //     08-17, and `render(await Component({...}))` has worked ever since.
      //     Nobody re-checked, so the file kept its 31.5% inside a gate it was
      //     already in. Both stale headers are corrected in the same commit.
      //
      //     ⚠ THIS TIME `functions` IS RAISED, and the reason is that the
      //     wobble was MEASURED rather than assumed away. Three consecutive runs
      //     on the new tree: 89.51 / 89.48 / 89.59 — a 0.11pt spread, matching
      //     the figure recorded in testing-and-ci.md exactly. So the seat below
      //     is set 0.18 under the LOWEST sample (1.6x the observed spread), not
      //     under the highest. The other three metrics are seated the same way,
      //     under their minimum of three: st 90.97, br 82.09, lines 93.89.
      //     Raising against a known spread is the thing the 89.1 note asked for
      //     ("raise it once the spread is known"); raising against one sample
      //     is what it forbade.
```

## §13 · `vitest.workers.config.ts` › above `export default defineConfig({`

```text
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
```

## §14 · `vitest.workers.config.ts` › above `"@supabase/supabase-js": path.resolve(`

```text
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
```

## §15 · `vitest.workers.config.ts` › above `testTimeout: 30_000,`

```text
    // ── testTimeout: 30s, raised from vitest's 5s DEFAULT (2026-08-24) ────────
    // ⚠ NOT to paper over slow tests. This repo has DOZENS of guards whose job is
    // to walk the whole tree and read every file — the honesty ratchets, the
    // completeness sweeps, the leak guards. Several sit at 1–3.5s standalone and
    // cross 5s under the FULL PARALLEL RUN's load, so WHICH ONE reds is luck:
    // measured 2026-08-24, three separate full runs each failed a DIFFERENT file
    // (worker-test-completeness at 5236ms, then no-constant-foldable-joined-
    // templates, then api-allday-listings-indexer) and every one passed in
    // isolation.
    //
    // ⚠ A guard that reds for being SLOW is indistinguishable at a glance from one
    // that FOUND something, and it trains exactly the skimming that let a real
    // failure hide in a red suite earlier the same day.
    //
    // 🚨 AND THE 5s DEFAULT WAS ACTIVELY MISLEADING, which is the stronger reason.
    // The three worker suites fixed on 2026-08-24 reported "Test timed out in
    // 5000ms" — so they read as flaky scheduling. At --testTimeout=60000 the mask
    // came off and they were ORDINARY ASSERTION FAILURES underneath, from a real
    // defect (a nested node_modules defeating vi.mock). The timeout was hiding the
    // error, not reporting one.
    //
    // The cost is stated: a genuinely HUNG test now takes 30s to fail instead of 5.
    // That is the right trade — "timeout" should mean "actually stuck", not
    // "unlucky scheduling". Full case: docs/reference/testing-and-ci.md.
```

## §16 · `vitest.workers.config.ts` › above `reportsDirectory: "coverage-workers",`

```text
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
```

## §17 · `vitest.workers.config.ts` › above `thresholds: {`

```text
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
```
