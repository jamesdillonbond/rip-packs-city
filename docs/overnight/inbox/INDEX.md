# Inbox index — 192 live filings

**Generated 2026-08-22 (PT) by Claude Code, deep-audit R27.**

## Why this file exists

`docs/overnight/inbox/` had not been archived since 2026-08-13 and had grown to 188 live
files nine days deep, so **drained and open became indistinguishable** and the run-3 audit's own
brief estimated "~29 files" — off by more than 5x. That miscount is itself the evidence the
signal had degraded silently, and it breaks cheap-check (1) of the audit protocol, which tells
every session to grep ALL of `inbox/*` before measuring anything.

## Why the files were NOT archived

Archiving by date was considered and **rejected**. The `rpc-nightly-autonomous-pass` task
DRAINS this directory: moving a filing that was never acted on would silently remove it from
that queue, and nothing would ever surface it again. A date is not a drained-determination, and
no per-item drained state exists to read. **Archiving is Trevor's call, not a chore** — the
safe half (making the contents scannable in one read) is done here; the destructive half is not.

## How to use it

Scan this file instead of opening 188 documents. ⚠ It is a **listing, not a status**:
presence here says nothing about whether an item was acted on. The canonical open list is
[deep-audit-register.md](../../audits/deep-audit-register.md) — an item that matters and is
still open should have a register row, and if it does not, that gap is the finding.

⚠ **Regenerate this file when you add filings**, or it becomes another rotted map — the exact
failure it documents.

---

## 2026-08-22 — 26 filings

- [RESOLVED, SHIPPED, and carrying three of my own corrections: Golazos Series 2/3 never existed on chain (nextSeriesID=2) and the rows are deleted; the series route was 500ing on every collection because a rollup that ALREADY EXISTED had no reader — now 26/26 URLs return 200](2026-08-23T0210Z-golazos-series-2-and-3-never-existed-and-the-whole-series-route-is-dead.md)

- [/api/ready has been 500ing for eight days, and it settles a disagreement](2026-08-23T0025Z-api-ready-has-been-500ing-for-eight-days-and-it-settles-a-disagreement.md)

- [pg_cron reports 141/144 successes while allday-pack-opens-backfill has written nothing for 12.6h](2026-08-23T0200Z-allday-pack-opens-backfill-silent-while-pg-cron-reports-141-successes.md)

- [`collection_series` claims LaLiga Golazos has Series 2 and Series 3 — no instrument we own can see a single moment from either, and the series filter offers both](2026-08-23T0020Z-golazos-collection-series-claims-two-seasons-that-no-instrument-can-see.md)
- [The production bundle rendered a user-facing sentence that the committed source does not contain — a `+`-joined template literal lost the tail of its first chunk](2026-08-22T2135Z-production-bundle-dropped-a-string-segment-the-source-contained.md)
- [20 guards share a copy-pasted `stripComments` that hides 109,123 characters of real source — a `//` comment containing `/*` swallows every line until the next `*/`](2026-08-22T2105Z-stripcomments-hides-109k-chars-of-real-source-from-20-guards.md)
- [The cross-collection board hardcodes "143 wallets" in its SEO description and in the text users share — the true count is 221](2026-08-22T2050Z-cross-collection-board-hardcodes-143-wallets-in-seo-and-share-text.md)
- [The saturation is structural, not a spell — a measured waste ledger](2026-08-22T1956Z-the-saturation-is-structural-a-waste-ledger-from-pg-stat-statements.md)
- [The unbounded-server-read class bit a FOURTH time — and 23 more instances sit outside the guard written to stop it](2026-08-22T1929Z-23-unbounded-server-reads-live-outside-the-guard-that-exists-for-them.md)
- [Five public pages exceeded 30s to `domcontentloaded` in the 13:15Z e2e run — and the same pages were clean at 07:16Z and 18:58Z](2026-08-22T1905Z-five-public-pages-exceeded-30s-to-domcontentloaded-inside-the-degraded-band.md)
- [The zero-denominator percentage family: two gate meters fixed, three write-sites filed rather than changed](2026-08-22T1850Z-zero-denominator-percentages-two-gate-meters-fixed-three-write-sites-filed.md)
- [86 distinct mobile controls are under the 44px tap-target floor — a DESIGN decision, not a bug list](2026-08-22T1836Z-86-mobile-tap-targets-under-44px-and-the-instrument-that-found-them.md)
- [The roadmap's #1 metric is unreadable ~20 hours a day, and the cause is structural — but my candidate fix did NOT validate](2026-08-22T1745Z-the-headline-accuracy-metric-is-unreadable-20h-a-day-and-the-cause-is-structural.md)
- [🚨 P0 — the 2026-08-03 credential purge was DEFEATED: the purged blob is still reachable on a stale branch of the PUBLIC repo](2026-08-22T1620Z-P0-the-08-03-credential-purge-was-defeated-by-a-stale-public-branch.md)
- [The pg_cron `job startup timeout` class finally has a named cause — and a near-miss that would have frozen a stale MV permanently](2026-08-22T1600Z-the-startup-timeout-class-has-a-named-cause-and-a-near-miss-that-would-have-frozen-an-mv.md)
- [`candy-editions-ingest` — the 08-04 timeout fix SHIPPED and it is silent again for the same reason at a higher ceiling](2026-08-22T1600Z-candy-editions-is-band-killed-not-timeout-fixed.md)
- [`pinnacle-sync` was a FALSE stall — the arm watched a self-report while the outcome had no arm at all. Plus: the hydrator's schedule is declared nowhere in the repo](2026-08-22T1545Z-pinnacle-sync-was-a-false-stall-and-the-hydrator-schedule-is-in-no-repo-file.md)
- [Daytime monitor — 2026-08-22T1509Z (~08:06 PT, first-tick-of-day)](2026-08-22T1509Z-daytime-monitor.md)
- [One of the four never-run walkers is a DUPLICATE of a live pipeline, not a gap — and that halves the decision](2026-08-22T1500Z-one-of-the-four-never-run-walkers-duplicates-a-live-pipeline.md)
- [Two dropped checks, executed: the concierge probe PASSES, and NBA projections has been dark for 18 days on zero arms](2026-08-22T1450Z-nba-projections-18-dark-days-and-the-concierge-probe-check-nobody-ran.md)
- [The disk-IO budget, ranked: 7,809 GB / 242h, and the two priciest boards are LIVE (I nearly filed the opposite)](2026-08-22T0340Z-the-disk-io-budget-ranked-and-three-switches-that-mean-live.md)
- [Ask-corroboration is Top-Shot-only BY DESIGN — and extending it to All Day is worth 320 editions (+5.2pp on that collection, +1.1pp on the gate)](2026-08-22T0320Z-ask-corroboration-is-top-shot-only-BY-DESIGN-and-it-is-worth-320-allday-editions.md)
- [The accuracy gate, measured: 31.3% at HIGH/MEDIUM — and it tracks LIQUIDITY, not the pricing algorithm](2026-08-22T0256Z-the-accuracy-gate-measured-31pct-and-it-tracks-liquidity-not-the-algorithm.md)
- [`reconcile-saved-wallet-stats`'s "is the sweep keeping up?" metric measures a population the sweep excludes by construction — and it misled me today](2026-08-22T0130Z-oldest-cache-h-measures-a-population-the-sweep-excludes-by-construction.md)
- [`refresh_wmc_fmv_changed`'s temp-table build costs 120× what it needs to — and my own "permanently backlogged" reading of that function is WITHDRAWN](2026-08-22T0010Z-refresh-wmc-fmv-changed-temp-build-is-120x-its-necessary-cost-and-my-backlog-reading-is-withdrawn.md)
- [Daytime monitor — 2026-08-22T00:06Z (2026-08-21 17:06 PT)](2026-08-22T0006Z-daytime-monitor.md)

## 2026-08-21 — 16 filings

- [ESCALATION — the cross-collection mats have failed EVERY daily run since 08-18, the board is 4d19h stale, and the 08-18 filing's own escalation trigger fired three days ago](2026-08-21T2340Z-ESCALATION-the-cross-collection-mats-have-failed-every-day-since-08-18.md)
- [The `deals` board is a VICTIM of a global 20h/day slowdown, not its cause — and the same window costs FMV recalc ~19 hours a day](2026-08-21T2315Z-the-deals-board-is-a-victim-and-fmv-recalc-loses-19-hours-a-day.md)
- [The flagship `deals` board fails ~80% of refreshes, is up to 15.1h stale, and the failure is ~20h/day — not the 05–08:30Z saturation window](2026-08-21T2245Z-the-deals-board-fails-80pct-of-refreshes-and-is-20h-a-day-not-a-saturation-window.md)
- [Daytime monitor — 2026-08-21T21:05Z (14:05 PT)](2026-08-21T2105Z-daytime-monitor.md)
- [259 reads in `app/api/**` never destructure `error` — and two existing honesty guards exclude that tree on a premise that is false](2026-08-21T1945Z-259-route-reads-never-look-at-their-error-and-two-guards-exclude-app-api-on-a-false-premise.md)
- [`allday-pack-opens-backfill` throughput collapsed ~1,000× on 2026-08-11 — ETA to floor is now ~12 years](2026-08-21T1735Z-allday-pack-opens-backfill-throughput-collapsed-1000x.md)
- [Vercel's runtime-error ROUTE attribution is smeared — the homepage is not failing on a Panini board](2026-08-21T1730Z-vercel-runtime-error-route-attribution-is-smeared.md)
- [Four of the nineteen hardened event-range walkers have never run](2026-08-21T1701Z-four-of-the-nineteen-hardened-walkers-have-never-run.md)
- [Daytime monitor — 2026-08-21T15:05Z (≈08:05 PT, first tick of day)](2026-08-21T1505Z-daytime-monitor.md)
- [An upstream HTTP error defeats the cursor hold in 7 of 8 block-scan indexers](2026-08-21T1420Z-an-http-error-defeats-the-cursor-hold-in-7-of-8-indexers.md)
- [Two wrangler configs deployed to ONE Cloudflare worker, and the fossil would have silently downgraded the live one](2026-08-21T0510Z-two-wrangler-configs-deployed-to-one-worker-and-the-fossil-would-have-downgraded-it.md)
- [Two findings from the coverage pass's tail — 2026-08-20 (PT)](2026-08-21T0400Z-two-findings-from-the-coverage-pass-tail.md)
- [Daytime monitor — 2026-08-21T03:09Z (≈20:09 PT, 08-20 evening)](2026-08-21T0309Z-daytime-monitor.md)
- [Area (7)'s render-layer gap is already closed — 30 of 31 server pages discriminate, and a source guard would red on correct code](2026-08-21T0245Z-area-7s-render-layer-gap-is-already-closed-and-a-source-guard-would-red-on-correct-code.md)
- [The five-source caller rule is blind to `pg_trigger` — 33 live functions read as dead, and area (5)'s headline item is a false positive](2026-08-21T0140Z-the-caller-rule-is-blind-to-triggers-and-item-5s-headline-is-a-false-positive.md)
- [Three anon-public tabs declare a canonical pointing at a URL that 302s Googlebot to /login](2026-08-21T0030Z-three-anon-public-tabs-canonicalise-to-a-login-wall.md)

## 2026-08-20 — 4 filings

- [Test-coverage analysis — 2026-08-20 (PT)](2026-08-20T2325Z-test-coverage-analysis.md)
- [Daytime monitor — 2026-08-20T21:08Z (≈14:08 PT)](2026-08-20T2108Z-daytime-monitor.md)
- [Daytime monitor — 2026-08-20T03:06Z (≈20:06 PT)](2026-08-20T0306Z-daytime-monitor.md)
- [Daytime monitor — 2026-08-20T00:12Z (≈17:12 PT)](2026-08-20T0012Z-daytime-monitor.md)

## 2026-08-19 — 3 filings

- [Daytime-peak saturation spell — SYMPTOM filing (do not act causally)](2026-08-19T2107Z-daytime-peak-saturation-spell-symptom.md)
- [Daytime monitor — 2026-08-19T15:11Z (≈08:11 PT, first tick)](2026-08-19T1511Z-daytime-monitor.md)
- [Daytime monitor — 2026-08-19T00:06Z (2026-08-18 ~17:06 PT)](2026-08-19T0006Z-daytime-monitor.md)

## 2026-08-18 — 29 filings

- [Daytime monitor — 2026-08-18T21:10Z (in an active saturation spell)](2026-08-18T2110Z-daytime-monitor.md)
- [UFC dormancy: every DB-side instrument agrees, one apparent counter-signal is REFUTED, and the decisive test is still operator-only](2026-08-18T2100Z-ufc-dormancy-is-consistent-but-the-decisive-test-is-still-operator-only.md)
- [⛔ RETRACTION — Top Shot is NOT losing ground. I read a burst as a trend, from two points.](2026-08-18T2100Z-RETRACTION-top-shot-is-not-losing-ground-i-read-a-burst-as-a-trend.md)
- [The rotation works — and Top Shot is still losing ground. The one unverified inference is refuted.](2026-08-18T1930Z-the-rotation-works-and-top-shot-is-still-losing-ground.md)
- [The wmc backfill converts again (0 → 1,000 a tick), and the cross-collection mat timeout was saturation, not growth](2026-08-18T1835Z-the-wmc-backfill-starvation-is-fixed-by-scoping-and-the-ccm-timeout-was-saturation.md)
- [52% of `net._http_response` is one HEALTHY pipeline abandoning its own replies at the 5000 ms default](2026-08-18T1835Z-half-of-net-http-response-is-one-healthy-pipeline-at-the-5000ms-default.md)
- [Six of the eight "de-hardcoded" gate functions never had that code deployed — their secrets are inert](2026-08-18T1830Z-six-de-hardcoded-gate-fns-never-had-that-code-deployed-BLOCKER.md)
- [Candidate — `rpc-roll-pack-ask-hourly-low` shows a `deadlock detected` signature (SYMPTOM, observed in a spell)](2026-08-18T1808Z-roll-pack-ask-hourly-low-deadlock-signature-during-a-saturation-spell-SYMPTOM.md)
- [`idx_wmc_fmv_conf_null` is BUILT — and the route that built it overturns a recorded "impossible". The backfill is still converting ~0 rows, for a different reason.](2026-08-18T1725Z-wmc-fmv-conf-index-SHIPPED-via-pg_cron-and-the-backfill-is-starved-by-a-pinnacle-head-block.md)
- [The four-source caller rule is blind to Cowork artifacts — 8 live objects read as dead](2026-08-18T1620Z-the-four-source-caller-rule-is-blind-to-cowork-artifacts.md)
- [`idx_wmc_fmv_conf_null` — finding VERIFIED, fix READY, build BLOCKED on an idle window (and it left an INVALID index you must drop first)](2026-08-18T1545Z-wmc-fmv-confidence-index-verified-and-ready-but-BLOCKED-on-an-idle-window.md)
- [`get_fmv_coverage()` plans the SAME correlated `EXISTS` twice — and it took the whole data-integrity monitor down](2026-08-18T1510Z-get-fmv-coverage-plans-the-same-exists-twice.md)
- [Daytime monitor — 2026-08-18 ~08:06 PT (15:06Z) · FIRST-TICK-OF-DAY](2026-08-18T1506Z.md)
- [pack-EV / `fmv_current`: the LATERAL fix is verified equivalent — and the fixture-preserving alternative is refuted](2026-08-18T1410Z-pack-ev-lateral-verified-and-the-array-pushdown-does-not-transfer.md)
- [`compute-golazos-pack-ev` is SETTLED: not cron, not retention, NOT saturation — and the freshness arm reads green through it](2026-08-18T1406Z-golazos-pack-ev-is-not-saturation-and-the-freshness-arm-cannot-see-it.md)
- [`drain-fmv-cold-tail`: the caller is healthy — the `after()` work is killed at `maxDuration`, and has been since June](2026-08-18T1400Z-drain-fmv-cold-tail-is-killed-by-maxduration-not-its-caller.md)
- [`drain-fmv-cold-tail` has STOPPED — and the other "genuine miss" was a false positive](2026-08-18T0515Z-drain-fmv-cold-tail-has-stopped-and-resolve-topshot-stubs-was-a-false-positive.md)
- [Blast radius of the watchlist derivation: 67 added → 4 breaching, 0 chronic — but only under a rule the rows do not use](2026-08-18T0455Z-watchlist-derivation-blast-radius-measured.md)
- [Watchlist coverage was measured against rows the monitor ignores — the blind spot is 67, not 62](2026-08-18T0450Z-watchlist-coverage-was-measured-against-rows-the-monitor-ignores.md)
- [Candidate — the durable fix for jobid 218: make the `LIMIT` bind. Plans + cardinalities MEASURED; the timing A/B is NOT](2026-08-18T0425Z-the-durable-fix-for-jobid-218-make-the-limit-bind-plans-measured-timing-not.md)
- [Candidate — systemic hourly heavy-cron pileup in the :13–:34 band is manufacturing IO-saturation spells](2026-08-18T0330Z-heavy-cron-collision-pinnacle-backfill-io.md)
- [Test-coverage analysis — where the remaining risk actually is (2026-08-18 02:30Z / 2026-08-17 19:30 PT)](2026-08-18T0230Z-test-coverage-analysis.md)
- [Answering the open question on #8: restoring ESPN alone will NOT refill `nba_players` — the roster fetch is SLATE-GATED, and the season is over](2026-08-18T0120Z-restoring-espn-alone-will-not-refill-nba_players-the-roster-fetch-is-slate-gated.md)
- [The Pinnacle null-edition pool IS the catalog-coverage gap — and parking those rows would hide a hole that is still widening](2026-08-18T0112Z-pinnacle-null-edition-pool-is-the-catalog-gap-and-parking-it-would-hide-a-widening-hole.md)
- [The board-liveness SWEEP completes only ~half the time — and `cron.job_run_details.status` under-reports that by 40%](2026-08-18T0105Z-the-board-liveness-sweep-completes-only-half-the-time-and-cron-status-under-reports-it.md)
- [The sports-proxy 403 is TWO different causes needing TWO different fixes — the "three providers tightening bot-blocking" framing is refuted](2026-08-18T0100Z-the-sports-proxy-403-is-TWO-causes-not-one.md)
- [`topshot-misattrib-drain` resolves fine but has NOT applied a re-key since 2026-08-07 — and my first severity read was 6.5x too high](2026-08-18T0050Z-misattrib-drain-resolves-but-has-not-applied-a-rekey-since-08-07.md)
- [Top Shot series 6/7/8 carry TWO different display labels, and both are user-visible](2026-08-18T0045Z-top-shot-series-6-7-8-have-two-different-display-labels-and-both-are-user-visible.md)
- [Daytime monitor: `compute-golazos-pack-ev` silent 17.5h + `get_team_players` 45s timeout on team pages](2026-08-18T0013Z-golazos-pack-ev-silent-17h-and-team-roster-rpc-timeout.md)

## 2026-08-17 — 21 filings

- [The 2026-08-15 conflated-subedition reorder FIXED the drain — and its `ok` flag makes the recovery invisible](2026-08-17T2345Z-the-conflated-subedition-drain-fix-WORKED-and-its-ok-flag-hides-it.md)
- [Watchlist coverage audit: 62 of 149 active pipelines are unwatched, 5 of them have zero successes — and a curated list is why](2026-08-17T2320Z-watchlist-coverage-audit-62-of-149-pipelines-are-unwatched.md)
- [`panini_sale_field_mapping_shortfall` is mathematically incapable of firing while `panini_sale_price_capture_dry_days` is breached — and its own comment says it "Reads 0" when it reads −19](2026-08-17T2245Z-the-panini-mapping-shortfall-arm-cannot-fire-while-its-sibling-is-breached.md)
- [UFC Strike has recorded ZERO sales for 96 days, and `ufc-sales-indexer` reports 112/113 ok while writing 0 rows](2026-08-17T2210Z-ufc-strike-has-had-zero-sales-for-96-days-and-the-indexer-reports-ok.md)
- [Daytime monitor — 2026-08-17T21:06Z (14:06 PT, afternoon tick)](2026-08-17T2106Z-daytime-monitor.md)
- [The sports-proxy 403 is NOT a secret problem — it is three upstreams 403'ing across TWO independent egress networks](2026-08-17T1845Z-the-sports-proxy-403-is-not-a-secret-it-is-three-upstreams-across-two-egress-networks.md)
- [Daytime monitor — 2026-08-17T18:06Z (11:06 PT, later tick)](2026-08-17T1806Z-daytime-monitor.md)
- [`raise_impossible_parallel_circ` is NOT waste — it is real data-integrity healing running at 28× the cadence its work arrives at](2026-08-17T1712Z-the-impossible-parallel-selfheal-is-not-waste-it-is-28x-over-cadenced.md)
- [`topshot-wmc-fossil-drain` times out proving emptiness — and it is on no watchlist, so neither arm sees it](2026-08-17T1656Z-the-fossil-drain-times-out-proving-emptiness-and-nothing-watches-it.md)
- [Daytime monitor — 2026-08-17T15:18Z (08:18 PT, first tick of day)](2026-08-17T1518Z-daytime-monitor.md)
- [The saturation self-throttle fails OPEN on a returned error — 9 routes, and it fails open exactly when it is needed](2026-08-17T1211Z-the-saturation-self-throttle-fails-OPEN-on-a-returned-error-in-9-routes.md)
- [`fmv-recalc` re-breached ~4 h after being marked CLOSED, and current saturation does not explain it](2026-08-17T0450Z-fmv-sweep-re-breached-4h-after-being-marked-CLOSED-and-saturation-does-not-explain-it.md)
- [`wallet-username-resolver` dies in its CANDIDATE SELECTION — and chasing why exposed an untested half of this repo's `statement_timeout` rule](2026-08-17T0440Z-wallet-username-resolver-dies-in-its-candidate-selection-and-the-proconfig-rule-has-an-untested-half.md)
- [The pg_cron startup timeout is NOT a worker-slot cap — it is the saturation, and the obvious config fix does nothing](2026-08-17T0410Z-the-pgcron-startup-timeout-is-not-a-worker-slot-cap-it-is-the-saturation.md)
- [Pipeline restoration sweep — 2 restored, 3 blocked on access I don't have, and the monitoring gap that let all of it run for days](2026-08-17T0320Z-pipeline-restoration-sweep-what-is-fixed-what-is-blocked-and-the-monitoring-gap.md)
- [Daytime monitor — 2026-08-17 03:10Z (20:10 PT Aug 16)](2026-08-17T0310Z-daytime-monitor.md)
- [⛔ REFUTED TWICE, ROOT CAUSE FOUND: pack-EV is slow because `fmv_current` never pushes down — not because the 12 h target is unaffordable](2026-08-17T0225Z-backfill-historical-pack-ev-chases-a-12h-target-it-can-never-hit.md)
- [`match-topshot-players` — failing every daily run since 08-14, and its declared 300 s budget is INERT](2026-08-17T0200Z-match-topshot-players-has-failed-every-run-since-08-14-and-its-300s-budget-is-inert.md)
- [`allday-unmapped-resolver-tail` — NOT broken; it is grinding an exhausted backlog at ~52 min / 3 days for 5 rows](2026-08-17T0130Z-the-allday-tail-resolver-is-not-broken-it-is-grinding-an-exhausted-backlog.md)
- [`candy-editions-ingest` — the runtime is unbounded on fixed work, and the maxDuration lever is exhausted](2026-08-17T0030Z-candy-editions-runtime-is-unbounded-and-the-clock-lever-is-exhausted.md)
- [⛔ The concierge is TWO faults stacked. Topping up fixes the newer one and leaves a ~94% failure rate in place.](2026-08-17T0015Z-concierge-is-TWO-faults-topping-up-leaves-a-94pct-failure-rate.md)

## 2026-08-16 — 33 filings

- [`panini_sale_price_capture_dry_days` is CRYING WOLF — it watches a field abandoned on 2026-08-08 while the live replacement works](2026-08-16T2355Z-panini-sale-price-is-wallet-scoped-not-a-lighter-payload.md)
- [`unmapped-sales-nfl_all_day` — the resolver is stuck in December, and the approved lever is NOT lossless](2026-08-16T2145Z-unmapped-resolver-is-stuck-in-december.md)
- [Daytime monitor — 2026-08-16T21:06Z (14:06 PT)](2026-08-16T2106Z-daytime-monitor.md)
- [✅ RESOLVED — the denominator existed all along: `fmv-recalc-heartbeat`. It was in my own 16:40Z query output and I read it as noise.](2026-08-16T2030Z-RESOLVED-the-denominator-existed-fmv-recalc-heartbeat-and-I-had-it-at-1640Z.md)
- [⛔⛔ CORRECTION #2 — `pipeline_runs` recorded **1 of 6** `fmv-recalc` invocations. My "deterministic page-0 poison" was a SELECTION ARTIFACT.](2026-08-16T2020Z-CORRECTION-2-pipeline_runs-sees-1-of-6-fmv-recalc-invocations.md)
- [⛔ CORRECTION — the FMV sweep failure is **NOT saturation**. Page 0 fails deterministically, and it will not self-heal.](2026-08-16T2015Z-CORRECTION-the-fmv-sweep-is-NOT-saturation-page-zero-is-deterministically-poison.md)
- [The institutional wallet walk is unstable, and everything derived from its diff is fiction](2026-08-16T1930Z-the-institutional-wallet-walk-is-unstable-and-its-diff-is-fiction.md)
- [pg_cron never STARTS ~2-4% of all scheduled ticks, and a lost tick writes no `pipeline_runs` row](2026-08-16T1921Z-pg-cron-loses-2-to-4-pct-of-all-ticks-and-writes-no-row.md)
- [86 anon-executable SECURITY INVOKER functions are invisible to `check_secdef_anon_exec_drift()`](2026-08-16T1910Z-86-anon-executable-invoker-fns-are-invisible-to-the-secdef-drift-check.md)
- [✅ FALSIFIER PASS 18:55Z — leg 324 fired, the arm CLEARED to 11.84. ⏰ The predicted RE-BREACH at ~20:07Z is still ahead.](2026-08-16T1855Z-FALSIFIER-PASS-leg-324-fired-arm-cleared-re-breach-still-expected-2007Z.md)
- [All Day realized pull value is capped at ~14% by pull ingest, not by the rollup — and the TS dist_id "collapse" is a maturation curve](2026-08-16T1840Z-allday-realized-pull-value-is-capped-at-14pct-by-pull-ingest.md)
- [`fmv_current` does not push a JOIN predicate through its `DISTINCT ON` — 1.05M buffers to fetch 40 rows](2026-08-16T1829Z-fmv-current-does-not-push-down-through-distinct-on.md)
- [Two operator-only blockers, both currently degrading a live user-facing path](2026-08-16T1750Z-two-operator-only-blockers-anthropic-403-and-atlas-proxy.md)
- [✅ SHIPPED 17:38Z — the trust-health freshness view is APPLIED. Its first query proves the pre-split monolith needed **928.6 s of a 600 s budget**.](2026-08-16T1740Z-SHIPPED-freshness-view-applied-and-the-monolith-needed-928s-of-a-600s-budget.md)
- [`ownership-onchain-walk` has failed two consecutive daily ticks, and nothing watches it](2026-08-16T1734Z-ownership-onchain-walk-has-failed-two-daily-ticks-unwatched.md)
- [⛔ The 08-12 "cheapest first" fix for wmc FMV drift is FALSIFIED — the catch-all sweep already times out on **26 wallets**](2026-08-16T1710Z-the-08-12-cheapest-fix-for-wmc-drift-is-FALSIFIED-the-sweep-times-out-on-26-wallets.md)
- [The React #418 hydration class is wider than `/insights` — 17 more date/time sites, FILED not fixed](2026-08-16T1706Z-the-418-hydration-class-is-wider-than-insights.md)
- [✅ VERIFIED 16:47Z — the `:13` collision fix passed its positive control. And the "contradiction" was never one.](2026-08-16T1650Z-VERIFIED-the-13-collision-fix-passed-its-positive-control.md)
- [2026-08-16T16:40Z — `fmv_sweep_wedge_hours` is diagnosed: the sweep FINISHED its catalogue pass, then died on the next pass's first page. Its dedicated stall arm reads **49.0 against breach 50.**](2026-08-16T1640Z-the-fmv-sweep-climber-is-diagnosed-and-its-own-stall-arm-is-1-point-from-firing.md)
- [The `:13` pg_cron collision — ✅ FIXED 2026-08-16, and the "operator-only" premise in this title was WRONG](2026-08-16T1630Z-the-13-collision-is-operator-only-and-thats-why-it-persists.md)
- [2026-08-16T16:15Z — the leg split will clear, RE-BREACH for ~40 min, then go green; and `pipeline_runs_daily` nearly made me file a fake 4-hour stall](2026-08-16T1615Z-leg-split-will-re-breach-at-2007Z-and-runs-daily-is-a-6h-stale-rollup.md)
- [DECISION — `rpc-panini-squeeze-v2`'s "not yet public" footer is WRONG and has been for 15 days: refresh it](2026-08-16T1600Z-DECISION-panini-squeeze-artifact-footer-is-15-days-stale.md)
- [`candy-editions-ingest`: the `maxDuration` lever is EXHAUSTED, not unshipped — and the route is not the defect](2026-08-16T1545Z-candy-editions-the-maxDuration-lever-is-EXHAUSTED-not-unshipped.md)
- [Daytime monitor candidates — 2026-08-16T15:25Z (~08:25 PT, first-tick)](2026-08-16T1525Z-daytime-monitor.md)
- [⛔ DO NOT RUN THE `:13` STAGGER — it is harmful as written, and it is currently QUEUED as "ready-to-run"](2026-08-16T1520Z-the-13-stagger-is-REFUTED-do-not-run-it.md)
- [Session close — 2026-08-15/16, Cowork cloud: the gate-key rotation item is closed, and three of my own filings were refuted](2026-08-16T1500Z-session-close-gate-key-closed-and-three-of-my-filings-refuted.md)
- [The trust precompute is starving leg-by-leg — and the fix I filed 15 h ago is already obsolete](2026-08-16T1455Z-trust-precompute-starving-leg-by-leg-and-my-own-fix-is-obsolete.md)
- [The gate-key rotation item is CLOSED — all 14 gate-keyed crons verified passing](2026-08-16T1455Z-gate-key-rotation-item-is-CLOSED-all-14-verified.md)
- [Daytime monitor — 2026-08-16T14:46Z (2026-08-16 07:46 PT · first tick of day)](2026-08-16T1446Z-daytime-monitor.md)
- [MEMORY / CORRECTION — `cron_heavy`-owned pg_cron jobs ARE reschedulable from the MCP/SQL editor; the "needs superuser/dashboard" claim is WRONG](2026-08-16T0030Z-cron-heavy-jobs-ARE-reschedulable-from-mcp-via-set-local-role.md)
- [The wallet-backfill error classifiers miss object-shaped rejections, and the cost is a permanently-red mega-wallet](2026-08-16T0025Z-wallet-backfill-error-classifiers-miss-object-shaped-rejections.md)
- [Daytime monitor — 2026-08-16T00:15Z (2026-08-15 ~17:15 PT)](2026-08-16T0015Z-daytime-monitor.md)
- [R8's heal would write TEAM NAMES into `editions.player_name` — do not run it](2026-08-16T0010Z-R8-would-write-team-names-into-player-name.md)

## 2026-08-15 — 20 filings

- [`remap_topshot_realign_miskeyed_subeditions` is SCAN-bound, so the filed p_limit fix is a no-op](2026-08-15T2350Z-realign-is-scan-bound-not-row-bound.md)
- [The driver-message leak has a SIXTH spelling, and both shared guards are blind to it by construction](2026-08-15T2341Z-the-driver-message-leak-has-a-sixth-spelling-in-a-sibling-key.md)
- [The trust-precompute 999 sentinel is unreachable on a timeout, and the fix is structural](2026-08-15T2240Z-the-999-sentinel-is-unreachable-on-a-timeout.md)
- [The Panini throughput gate will self-silence on the collapse it is currently catching](2026-08-15T2140Z-panini-throughput-gate-self-silences.md)
- [`drain-conflated-subeditions`: the route really is dead, but R7's stated impact is wrong — and the real one is worse](2026-08-15T1930Z-the-drain-is-dead-but-not-for-the-reason-filed.md)
- [The static-extension bypass is REAL — but the proof it ships with is not, and the control test settles it](2026-08-15T1838Z-static-ext-bypass-is-real-but-its-headline-proof-is-not.md)
- [Panini ingest: enumeration stops early, throughput down ~6×, and the freshness check is blind to it](2026-08-15T1830Z-panini-enumeration-stops-early-and-the-freshness-gate-is-blind-to-it.md)
- [Daytime monitor — 2026-08-15T~1810Z (≈11:10 PT)](2026-08-15T1810Z-daytime-monitor.md)
- [The nightly reconcile is failing and the cards are stale — but the proposed query-shape fix is REFUTED by measurement](2026-08-15T1700Z-reconcile-saved-wallet-stats-the-query-shape-fix-is-refuted.md)
- [Three heavy pg_cron jobs collide at minute :13 — the saturation has a schedule, and the fix is two `cron.alter_job` calls](2026-08-15T1630Z-three-heavy-pg-cron-jobs-collide-at-minute-13.md)
- [`fmv-recalc` is not running less — it is being KILLED at maxDuration, and nothing watches that](2026-08-15T1600Z-fmv-recalc-is-not-running-less-it-is-being-killed.md)
- [R4 is a CATALOG COVERAGE gap, not an indexer regression — and the FK is what makes it unfixable in place](2026-08-15T1530Z-R4-is-a-catalog-coverage-gap-not-an-indexer-regression.md)
- [Daytime monitor — 2026-08-15T15:10Z (~08:10 PT, first tick)](2026-08-15T1510Z-daytime-monitor.md)
- [The platform has TWO serial-multiplier models, and deep-audit run 2's P2 compared the homepage against the wrong one](2026-08-15T1507Z-two-serial-multiplier-models-and-the-audit-p2-is-wrong.md)
- [`refresh-insights-cache` fails to warm half its boards and has logged `ok: true` every single time](2026-08-15T1200Z-the-insights-cache-warms-half-its-boards-and-reports-perfect-health.md)
- [`pinnacle_fmv_history` silently drops the ASK_ONLY revision — 776 renders currently show a history value the catalog never published](2026-08-15T0620Z-pinnacle-fmv-history-silently-drops-the-ask-only-revision.md)
- [Daytime monitor — 2026-08-15T06:12Z (off-hours, 23:12 PT Aug 14)](2026-08-15T0612Z-daytime-monitor.md)
- [The `pg_net_http_403` CRITICAL is ONE job, and the Pinnacle "deployed or ineffective?" question is closed](2026-08-15T0540Z-the-403-critical-is-one-job-and-the-pinnacle-deploy-question-is-closed.md)
- [The entity-page timeouts are TWO families, and the biggest one is not a slow query](2026-08-15T0450Z-the-entity-page-timeouts-split-into-two-families-and-only-one-is-a-slow-query.md)
- [`refresh_wmc_fmv_changed` is the #2 disk reader and it is NOT a defect — it is the price of the `wmc.fmv_usd` denormalization](2026-08-15T0350Z-refresh-wmc-fmv-changed-is-the-price-of-the-wmc-denormalization.md)

## 2026-08-14 — 11 filings

- [The Top Shot catalog walk faulted 11 of 258 sets and nothing watches that counter](2026-08-14T2300Z-topshot-catalog-walk-faulted-11-sets-and-nothing-watches.md)
- [Two schedulers run the same wmc FMV propagation, and they lock each other out](2026-08-14T2230Z-two-schedulers-run-the-same-fmv-propagation-and-lock-each-other-out.md)
- [The Pinnacle FMV drift guard compares `pinnacle_catalog` to itself](2026-08-14T1930Z-pinnacle-fmv-drift-guard-is-a-tautology.md)
- [`get_pack_detail_bundle` cold-scans 3k× per pack page — the top user-facing error on the board](2026-08-14T1830Z-pack-detail-bundle-cold-scan-is-the-top-user-facing-error.md)
- [All Day's WAF 403 is almost certainly a ONE-LINE env change — `ALLDAY_PROXY_URL` route](2026-08-14T0500Z-allday-waf-403-is-a-one-line-env-fix.md)
- [Search players by college — a real collector hook RPC cannot answer today](2026-08-14T0330Z-search-players-by-college.md)
- [Daytime monitor — 2026-08-14T03:12Z (~20:12 PT, 08-13)](2026-08-14T0312Z-daytime-monitor.md)
- [Narrative search does not work: set names outrank the prose that answers the question](2026-08-14T0310Z-narrative-search-is-outranked-by-set-names.md)
- [Three older swallowed ledger headings (2026-08-11), unrepaired](2026-08-14T0210Z-three-older-swallowed-ledger-headings.md)
- [`/api/search` has no smoke probe, and it now has two consumers](2026-08-14T0204Z-api-search-has-no-smoke-probe-and-now-has-two-consumers.md)
- [Daytime monitor — 2026-08-14T00:14Z (~17:14 PT, 08-13)](2026-08-14T0014Z-daytime-monitor.md)

## 2026-08-13 — 14 filings

- [Profile flair + social-preview backlog (Claude Code, 2026-08-13)](2026-08-13T2345Z-profile-flair-and-social-preview-backlog.md)
- [`[collection]/analytics` renders a failed fetch as an empty market — 8 sections, 1 already fixed](2026-08-13T2340Z-collection-analytics-tabs-render-a-failed-fetch-as-an-empty-market.md)
- [The schema-cache 500s are SELF-INFLICTED: one ~20-second burst of user-facing errors per migration we apply](2026-08-13T2320Z-the-schema-cache-500s-are-self-inflicted-by-our-own-migrations.md)
- [The Sentry board triaged against the live DB — 2 reds were stale, 3 were fixed today, 6 are real](2026-08-13T2230Z-sentry-board-triaged-stale-vs-live.md)
- [Two `.from()` table reads on the edition page are still unbounded — the RPC half is fixed, this half is not](2026-08-13T2155Z-entity-page-from-table-reads-are-still-unbounded.md)
- [`get_series_detail` is a live, tens-of-seconds PUBLIC page query (Sentry NEXTJS-27), and the two obvious fixes are both WORSE](2026-08-13T2115Z-series-detail-is-a-live-20s-public-page-and-two-obvious-fixes-are-falsified.md)
- [Golazos is genuinely market-limited (measured ceiling ~2.8%), and the trust board's "stale" metric does not mean what its name implies](2026-08-13T2030Z-golazos-is-genuinely-market-limited-and-two-different-stales.md)
- [Inbox triage — 2026-08-13](2026-08-13T2000Z-inbox-triage.md)
- [The AllDay drain attribution is settled (keep jobid 22), and the insider-detector telemetry can drop 12 scans to 3](2026-08-13T1950Z-allday-drain-attribution-settled-and-the-insider-telemetry-merge.md)
- [Both open attribution questions are CLOSED — and neither needed the instrumentation we thought](2026-08-13T1930Z-403s-fully-attributed-and-jobid22-cleared.md)
- [Correction to the `get_allday_unresolved_pulls` prescription — the `ORDER BY` is load-bearing, and dropping it would break the only useful work this pipeline does](2026-08-13T1845Z-allday-pull-drain-is-a-forward-resolver-not-a-backlog-drain.md)
- [Rank the DB by disk reads and cache-hit ratio, not by time — and the one "obvious" index that turned out to be a regression](2026-08-13T1730Z-disk-read-ranking-and-the-pack-rips-plan-defect.md)
- [The recurring `pg_net_http_403` CRITICAL is ONE job — jobid 16 — and it is one of the three D2b calls "rotated + verified"](2026-08-13T1530Z-pg-net-403-attributed-to-jobid-16.md)
- [Daytime monitor — 2026-08-13T14:53Z (~07:53 PDT, first-tick-of-day)](2026-08-13T1453Z-daytime-monitor.md)

## 2026-08-12 — 9 filings

- [The board-warm failures now have names, and the numbers say capacity — not a missing index](2026-08-12T2330Z-board-view-timeouts-now-named.md)
- [pg_cron jobid 16 is 403ing 100% of its dispatches — real misconfiguration, LOW data impact, but it makes a brand-new CRITICAL arm permanently red](2026-08-12T1354Z-jobid16-403s-and-a-newly-critical-arm.md)
- [Three follow-ups on the D2 outage — one hazard, one confirmation, one fix that isn't a new monitor](2026-08-12T0430Z-suppression-predicate-and-secret-echo.md)
- [AllDay GraphQL returns 403 (HTML WAF block) through `ALLDAY_PROXY_URL` — edition hydrate may be silently dead](2026-08-12T0428Z-allday-graphql-403-waf-block.md)
- [Finding (CORRECTED) — the STALE label does not survive denormalization into wmc](2026-08-12T0358Z-stale-label-lost-in-wmc-denorm.md)
- [RESOLVED — the pack-opens "spork stall" was a 403 auth outage across 7 pg_cron jobs](2026-08-12T0330Z-edge-fn-403-outage-RESOLVED.md)
- [Daytime monitor candidates — 2026-08-12T03:09Z (≈2026-08-11 20:09 PDT)](2026-08-12T0309Z.md)
- [Decision-ready — `topshot_first_mint_trophy_stats` slow board: root-caused, urgency re-scoped, index-vs-precompute settled](2026-08-12T0056Z-first-mint-trophy-stats-index-vs-precompute.md)
- [Daytime monitor — 2026-08-12T00:12Z (≈17:12 PDT Aug 11)](2026-08-12T0012Z.md)

## 2026-08-11 — 2 filings

- [Inbox — 2026-08-11T17:46Z (10:46 PDT Aug 11) — Claude Code (interactive, read-only DB)](2026-08-11T1746Z-precompute-split-silent-stale-under-role-timeout.md)
- [The gate-key rotation — sized, and an ordering that does NOT reproduce the outage](2026-08-11T0300Z-gate-key-rotation-runbook.md)

## 2026-08-10 — 3 filings

- [Daytime monitor — 2026-08-10T21:07Z](2026-08-10T2107Z-daytime-monitor.md)
- [Queued — the liveness probe can be pruned by the planner, and 2 boards are still genuinely slow](2026-08-10T1900Z-board-liveness-probe-prunes-and-remaining-slow-boards.md)
- [Queued — cron budget headroom audit, the post-ship closes, and the next MV lever](2026-08-10T0555Z-cron-budget-headroom-audit.md)

## 2026-08-09 — 1 filing

- [PARTIALLY DRAINED — deals/rookies public-board backing views are I/O-bound](2026-08-09T1941Z.md)

