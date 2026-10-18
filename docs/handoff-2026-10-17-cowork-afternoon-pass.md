# Handoff — 2026-10-17 Cowork afternoon pass (cloud, linked to the laptop)

> ⚠ **SCOPE:** the push notes here are specific to this Cowork **cloud** session (repo attached mid-session with `add_repo`, direct `git push`). Trevor's machine and Claude Code push normally via Git Credential Manager — **commit these files as usual.**

**Run:** ~2:45 → ~5:45 PM PT 10-17, Trevor: "look through the project, recent audits, handoffs, known issues … tasks that you can take care of from here … work autonomously for the next 3 hours". A Claude Code session was committing concurrently all afternoon (last seen `b013712e2`, 2:59 PM).

**Verdict: GREEN · 13 shipped (2 scheduled-task prompts, 3 code commits with 4 fixes, 5 DB/pg_cron changes, 3 docs) · nothing waiting on Trevor · oldest routed: none older than today.**

## Health (2:48–3:05 PM PT)
- Security drift 0, `check_when_others_timeout_blind` 0, stalled `[]`, pg_cron recent failures none, trust breaches none.
- `check_zero_yield_lanes()`: the two Pinnacle lanes (already dispositioned benign, 10-17 overnight) + **`topshot-set-series-onchain`** (30-day baseline = 1 find; it only writes when a new series appears — due 10-20 with Series 2026-27; benign).
- Alerts: the known Atlas/Cloudflare 403 info rows + `topshot-pack-supply-atlas` 26.4 % (chronic). Vercel 12 h: 1 chronic group. Client-error beacon 7 d: 13 rows, all `automated:true` (the headless crawler).
- Accuracy gate (R125, 7 d, Top Shot): published ALL 14.3 % / ratio 1.000; HIGH 9.5 %. Holds.

## Shipped
1. **Panini freshness check prompt** (`trig_01K68ddYeWqUumNN2RavC4ht`, `ecc143d32`). The routine still ran the 10-01 text: the 10-04 mirror changes (FOURTH regime, `NO_DATA`, `absurd_24h` re-scope, walked-but-not-repriced split) had never reached it. Plus 10-17 edits from `claude/handoff-2026-10-17-panini-freshness-straggler-and-stale-gates.md`, re-measured live: FIFTH regime (`panini-1.3.0`, ~3 h walks, 34,696 editions); **Query 5 filters `extra ? 'enum'`** (registry/product_names rows share the pipeline name and were the newest row at 11:00 PT, a standing false trigger for Escalation 3); `pskus_per_min` only on `budget` rows; 3-h still-running test; two-day cohort gate; Query 6c; lone Escalation-5 straggler = NOTE. Read-back equal to the mirror. Watch: 10-18 11:00 AM run.
2. **Daytime monitor prompt** (`trig_01H9peMNj7LWJndZRrrbuAFA`, `777d1b5b7`, mirrored to `docs/scheduled-tasks/rpc-daytime-monitor.prompt.md`): push via the mount's `.rpc-git-cred` (the `pushurl` harvest it described is dead since 08-16); INDEX.md line + `fix-inbox-index-counts.mjs` in the same commit (simulated: passes); Sentry marked dark. Watch: the 5:04 PM PT run.
3. **Docs** (`2a404a15f`): device-bound routine prompts CAN be updated from a laptop-linked cloud session (`tooling-gotchas.md`, Panini mirror header).
4. **Candy pack art + empty series page** (`3bcf40138`): `getImageUrl`/`getVideoUrl` in `components/MomentMedia.tsx` appended Top Shot's `Hero_2880…png` / `Animated_…mp4` to every extension-less URL; Candy's art is a bare Arweave tx id (all 125 Candy editions), so `/candy-mlb/packs` rendered dead art (stored URL 404, bare tx id 200). Now only the legacy `assets.nbatopshot.com/editions/` prefix (no query) gets the suffixes. 4 new tests (fail on the old code), 91 related tests green. Same commit: `seriesPageMetadata` is noindex,follow on a measured `edition_count === 0` (UFC Series 0) and the empty-state copy drops "yet" (3 new `seo.test.ts` cases; one re-pinned test). Preflight: 7 steps, 0 failed.
5. **Timestamp correction** (`24e4b2b16`): three PT stamps I had estimated, corrected from commit times.
6. **Sitemap leaves out series measured at 0 editions** (`f5a4aa06e`): `getCollectionSeries()` drops `collection_series` rows whose `series_detail_rollup` row says `edition_count = 0` (prod: only UFC Series 0). No rollup row = unknown, kept; a failed rollup read prunes nothing. 3 new tests (the drop case fails with the filter off). Preflight 6 steps, 0 failed; CI/Smoke/E2E green; deploy READY; live `/sitemap/0.xml` lists series-1 and series-2 only (4:10 PM PT).
7. **Thin-FMV guard computes before TRUNCATE** (`20261017235000`, commit `9c43daab6`): applied 4:50 PM PT through the SQL editor after Trevor's go-ahead (4:46 PM PT). Live md5 `9dbaa011`, compute-first true, anon/authenticated EXECUTE false; one production call wrote the identical 16-edition set. Pin + drift-guard pointer committed together; all 266 DB pins pass locally; CI green. Watch: job 63 at 1:30 AM PT 10-18, no `insight_links` timeouts.
8. **FMV display guard computes before TRUNCATE** (`20261018000700`, applied 5:07 PM PT): live md5 `b41a6dfa`, compute-first true, grants unchanged; one production call wrote 691 rows (688 from the 1:45 AM run). Pin + drift-guard pointer committed (`a6ccabc1f`).
9. **Atlas drain samples its open-listing count** (`20261018001100`, applied 5:11 PM PT): ticks from 5:13 PM PT log `open_listings_nba` null; the :01/:31 ticks carry it. Migration header carries the R118 marker for the unchanged loop handler.
10. **Daytime monitor verified**: the 5:04 PM PT run pushed `09b09efb` at 5:13 PM PT with `INDEX.md`; CI green. Its HIGH filing (fmv-recalc sweep stuck in step 1b) was fixed by the concurrent Claude Code session in `9c1a184a`.
11. **Superseded 184 MB index dropped** (`20261018005800`, 5:58 PM PT): one-off pg_cron job 741 (the editor confirm click was blocked, then Chrome lost the tab). `to_regclass` NULL; covering index still valid; job unscheduled.
12. **`chain-arrival-flips` sleeps only when there is work** (`20261018011453`, 6:14 PM PT): the new zero-yield offender is a drained backlog (0 eligible candidates; 15,123 reads done, 12,981 found). Job 681 had held a pg_cron slot 27 s on every idle tick (720/day); the guard cuts that to 144/day, still logging every 10 min inside the 20-min silence watch. Idle ticks now 0.1–0.5 s, verified live. Not suppressed in the zero-yield detector — re-open if `enqueued` > 0 with `found` 0.
13. **M11 zero explained** (roadmap Now #3): positive control (one-off `SELECT 1/0` job recorded `failed`, the check saw it); the cliff is the 10-09 pack-pulls fix, not the 10-10 #181 parking a parallel session credited — corrected in roadmap, roadmap-status, go-live.
14. **All Day ask-corroboration re-enabled** (`1bfc17c86`, ~7:25 PM PT): the fmv-recalc liveness probe read a NULL `listed_at` (4,913 `storefront_v2` rows, NULLs sort first under DESC) and withheld every All Day LOW→MEDIUM lift since ~09-25. The would-lift set prices like MEDIUM (14 d: 20.7 % vs 20.0 % median error, n 855). Verified live: lag 0.2 h, 14 of the first 216 recomputed editions LOW→MEDIUM, 0 down. **Read M2 on the 10-18 legs.**

## Queued for Trevor / Claude Code
- None. All four 10-17 `docs/pending-sql/` statements are applied and committed.

## Recorded, not changed
- **UFC Series 0**: page now noindex with honest copy (`3bcf40138`), and since `f5a4aa06e` it is out of the sitemap (see Shipped 6). 371 of 518 UFC editions have `series` NULL (ingested 05-10 → 06-22, after close), so they appear on no series page. Closed archive; recorded only.
- **Two malformed UFC rows**: `KHABIB-TIME-901` (player "Khabib Time 901", set "901") and `YOU-SUCK-2-0-750` (set "2 0") — mint number parsed into the name. Literal UPDATE = held.
- **Golazos packs**: 0 of 32 rows has a price, so "cheapest first" shows retired packs with "—". Honest, not a sort defect.
- **10-16 2:11 PM PT burst** (6 Vercel groups: pack-detail reads + market-cap tiles, each "read exceeded 5000/8000ms", 1 user): no Postgres timeout or lock message in 2:05–2:16 PM, no migration applied then, only the always-on lanes running. No attributable cause — one slow page load; not chased further.
- **Two transient 502s** in the mobile pass (a static chunk, a `/login` prefetch); both 200 on 3× re-probe — likely the container's egress proxy.

## Rendered-DOM QA (anonymous Playwright from the cloud container)
- Desktop: 85 pages (Candy, Panini, All Day, Golazos, UFC, Pinnacle tabs + 1–2 entity pages per type, insights boards, blog/static). All 200, 0 overflow, 0 console errors, 0 failed requests.
- Mobile 390 px: 43 pages. All 200, 0 overflow.
- Insights boards: the 25 not covered above (all 200, 0 overflow, 0 console errors). `/insights/offer-spread`'s 21 "$0.00" are the SPREAD column where bid = floor — correct; the board discloses "176 of 200 asks unconfirmed".
- Post-ship (verified live): `/candy-mlb/packs` dead art 0 (was 1), ICONs pack image loads from the bare Arweave id; `/ufc/series/series-0` serves `noindex, follow`.
- ⚠ In this container (2 CPUs) the sweep's in-page measurement costs ~1 page/min at concurrency 3; size samples to ~80 pages.

## Failed / blocked
- `apply_migration` of the thin-FMV fix → `{"status":"cancelled"}` (expected hold). Not retried, not routed around.
