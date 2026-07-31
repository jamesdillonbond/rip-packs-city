import { defineConfig } from "vitest/config"
import path from "path"

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
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    // Only the component/hook suites (they self-declare `// @vitest-environment
    // jsdom`); the node-env route/lib suites stay in the primary config.
    include: ["__tests__/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Scoped to the subtrees where LOGIC-bearing components concentrate
      // (financial display, sort/filter, data shaping) — the ones worth a gate.
      // A whole-tree include drowns the signal in ~370 presentational files and
      // pins the number near 5%. Add a subtree here as its components gain tests.
      include: [
        "components/*.tsx",
        "components/analytics/**/*.tsx",
        "components/profile/**/*.tsx",
        "components/packs/**/*.tsx",
        "components/entity/**/*.tsx",
        "components/sniper/**/*.tsx",
        "components/collection/**/*.tsx",
        "components/pinnacle/**/*.tsx",
        "components/alerts/**/*.tsx",
        "components/fast-break/**/*.tsx",
        "components/rtr/**/*.tsx",
        "components/insights/**/*.tsx",
        // app/insights/**/*Client.tsx — the public /insights board CLIENT bodies
        // (top-sales, deals, market, offer-spread, …). ~23 files / ~12.6k lines
        // of financial display + sort/filter logic that lived under app/ where
        // NEITHER coverage gate measured them (the primary gate is lib/** +
        // app/api/**/route.ts; this gate was components/** only). Scoped to
        // *Client.tsx so the async server page.tsx wrappers — which can't be
        // cleanly rendered in jsdom — don't drown the signal. Added 2026-07-31.
        "app/insights/**/*Client.tsx",
      ],
      exclude: ["**/*.test.tsx", "**/*.d.ts"],
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
      thresholds: {
        statements: 64.5,
        branches: 53.4,
        functions: 61.4,
        lines: 68.1,
      },
    },
  },
})
