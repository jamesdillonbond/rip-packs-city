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
      thresholds: {
        statements: 43.7,
        branches: 36,
        functions: 51.4,
        lines: 45.8,
      },
    },
  },
})
