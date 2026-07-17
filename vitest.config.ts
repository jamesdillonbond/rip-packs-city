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
      thresholds: {
        statements: 73.7,
        branches: 58.6,
        functions: 78.7,
        lines: 76.3,
      },
    },
  },
})
