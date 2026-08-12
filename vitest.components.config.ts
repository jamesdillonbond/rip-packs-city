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
        // Added 2026-07-31 (test-coverage pass): three previously-UNMEASURED
        // logic-bearing subtrees, now gated so they can't silently rot. The new
        // __tests__/component-gate-include-completeness.test.ts rot-guard fails
        // CI if any components/<subtree> is in neither this include nor its
        // explicit allowlist. auth = the sign-out + pro-badge siblings (its
        // ConnectButton went with the 2026-08-08 wallet-sign-in removal);
        // marketplace-status = the per-collection banner/chip/pill; onboarding =
        // the first-run tour.
        "components/auth/**/*.tsx",
        "components/marketplace-status/**/*.tsx",
        "components/onboarding/**/*.tsx",
        // Added 2026-08-01 (KNOWN_UNMEASURED audit): two subtrees that had been
        // allowlisted with inaccurate "presentational" reasons but carry real
        // branch logic. pricing = StripeSubscribeButton's fetch state machine
        // (401→login redirect / url→checkout / !ok error / thrown-fetch error) —
        // the only paid-conversion path, NOT "static marketing". filters =
        // LeagueFilter's visible gate + active-toggle + fire-only-on-change.
        "components/pricing/**/*.tsx",
        "components/filters/**/*.tsx",
        // Added 2026-08-11: the global catalog search bar. Logic-bearing on
        // arrival — a debounced fetch with out-of-order response rejection, a
        // 4-state status machine whose error state must stay DISTINCT from
        // "no results", and keyboard listbox navigation.
        "components/search/**/*.tsx",
        // app/insights/**/*Client.tsx — the public /insights board CLIENT bodies
        // (top-sales, deals, market, offer-spread, …). ~23 files / ~12.6k lines
        // of financial display + sort/filter logic that lived under app/ where
        // NEITHER coverage gate measured them (the primary gate is lib/** +
        // app/api/**/route.ts; this gate was components/** only). Scoped to
        // *Client.tsx so the async server page.tsx wrappers — which can't be
        // cleanly rendered in jsdom — don't drown the signal. Added 2026-07-31.
        "app/insights/**/*Client.tsx",
        // Three insights surfaces are CLIENT page.tsx files (not the *Client.tsx
        // convention), so the glob above missed them and they sat under app/
        // measured by NEITHER gate despite carrying real wallet-paste + fetch +
        // row-mapping logic. Named by explicit path (the only client page.tsx
        // under app/insights) so the server page.tsx wrappers stay out. The
        // insights-gate-include-completeness rot-guard keeps this list honest.
        // Added 2026-08-01.
        "app/insights/squeeze-check/page.tsx",
        "app/insights/tc-report/page.tsx",
        "app/insights/pack-reality/page.tsx",
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
      thresholds: {
        statements: 88.5,
        branches: 79.4,
        functions: 88.2,
        lines: 91.6,
      },
    },
  },
})
