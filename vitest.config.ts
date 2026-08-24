import { defineConfig } from "vitest/config"
import path from "path"

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
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
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
      reportsDirectory: "coverage",
      reporter: ["text", "html"],
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
      include: [
        "lib/**/*.ts",
        "lib/**/*.tsx",
        "app/**/route.ts",
        "app/**/route.tsx",
        "supabase/functions/_shared/**/*.ts",
        "proxy.ts",
      ],
      exclude: ["lib/**/*.test.ts", "lib/**/*.d.ts"],
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
      thresholds: {
        statements: 91.8,
        branches: 79.4,
        functions: 93.6,
        lines: 93.85,
      },
    },
  },
})
