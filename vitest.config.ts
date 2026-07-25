import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
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
      include: ["lib/**/*.ts", "app/api/**/route.ts"],
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
      thresholds: {
        statements: 80.9,
        branches: 66.3,
        functions: 85.7,
        lines: 83.6,
      },
    },
  },
})
