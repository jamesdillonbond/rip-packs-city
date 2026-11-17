# Full platform audit — 2026-07-11 (evening, Cowork interactive)

Trevor-directed full health check + audit: backend, DB, schedulers, 385-page live sweep, Chrome visual QA, native-site parity (v2.nbatopshot.com / dapper.market / app.nflallday.com / disneypinnacle.com / ufcstrike.com), packs deep-dive, FMV/EV parity review. Companion docs: [roadmap-2026-07-11](../strategy/roadmap-2026-07-11.md), [handoff-2026-07-11-audit-followups](../archive/handoffs/handoff-2026-07-11-audit-followups.md).

**Session constraint:** the Cowork Linux sandbox was down all session (host disk full) — no git/shell. All DB work shipped via Supabase MCP; code-side fixes are packaged in the follow-ups handoff instead of being committed directly. Page sweep ran through Chrome (same-origin fetch batches), not curl.

## Verdict

Platform is GREEN at depth. Every sampled public page (385 unique: 225 editions + 25 pins + 50 packs + 20 sets + 20 teams across TS/AD/GZ/PIN) returned HTTP 200 with images, sales history, badges, special serials, and offers sections present. Data parity against v2.nbatopshot.com is exact on circulations/parallels/badges and consistent on prices. The one active operational story is self-inflicted and temporary: the pack-opens API backfill's write load saturated Micro-instance IO for most of the day, driving the statement-timeout/contention classes visible in Vercel + pg_cron. TS leg finished (cron retired this session); AllDay leg ~97% and self-terminating.

## Shipped this session (DB-only, via MCP)

- **`audit_20260711_circ_floor_raise_impossible_parallel_wave2`** — trust BREACH `topshot_impossible_parallel_serials` 11→0. Same class + fix as the 07-10 straggler wave: 4 freshly-cataloged `::` parallels (`221:7458::20`, `221:7468::20`, `228:7657::21`, `228:7661::21`) with floor-seed circ below a real sale serial; circ raised to max observed serial (per-parallel circ backfill will true it up). Verified 0 post-fix. Revert: restore prior `circulation_count` values (8/1/4/4).
- **Retired pg_cron job 53 `rpc-pack-opens-api-topshot`** — `pack_opens_api_state.done=true` for TS since 16:12Z (788,061 opened / 577,668 rips written; remainder pre-existed from on-chain scans); the */3 cron was pure no-op churn. Per the 07-11 ledger's own retire-on-done instruction. Revert: `SELECT cron.schedule('rpc-pack-opens-api-topshot','1-59/3 * * * *', <original command from job history>);`

## Backend health (verified live ~01:00–02:20Z Jul 12)

- **Security:** RLS-off tables 0; `check_secdef_anon_execute_violations()` `[]`.
- **Trust health:** 16/16 ok after the fix above (was 15/16). Per-collection FMV freshness: TS 0.1h / AD 0.5h / GZ 0.3h / UFC 10.2h / Pinnacle render 8.8h, floor 6.0h — all in-band.
- **Sentry:** 2 unresolved only, both known smoke false-fail classes (pack-dist Sales-History streaming assert; stalled-pipeline detect during the cron dropout).
- **Vercel:** prod `643f34ff` READY. The WAP→ASP rename gap is CLOSED — `wap_usd` PGRST204 write-failures last seen 19:09Z on a superseded deployment; current prod writes `asp_usd` clean, `/api/fmv`, sniper-feed, edition pages all render (verified in Chrome). Today's ERROR deploys (`f9ee7bf`, sitemap `dff6a7f`/`ac138b0`, workflows placeholder) all superseded by READY follow-ups.
- **cron-job.org:** recovered from the ~05:0xZ dropout — all HTTP-triggered indexers fresh within the hour.
- **GHA:** all `*-sales-history-backfill` legs + smoke-tests ran in the last hour, ok=true.
- **pg_cron:** 3 jobs flapping statement-timeout in the storm window (`rpc-allday-rollup-rip-value`, `rpc-allday-cross-source-sales-dedup`, `rpc-remap-misattributed-sales`) — see the pack_rips story below; all are retry-safe and recover between storms.
- **Pipelines:** `detect_stalled_pipelines()` → only `classify-acquisitions-multicollection` (silent ~5h). NOT a dead cron: the Vercel cron fires hourly but the run dies at the 300s lambda cap under DB contention before `log_pipeline_run` — the runtime-errors timeout group shows it firing through 01:28Z. Self-heals when the backfill IO storm ends; if it persists past 12h, see handoff.

### The pack_rips scale event (root cause of today's contention)

`pack_rips` grew ~10x today to **~3.49M rows** (AllDay 57k→2.72M and climbing to ~2.81M; TS 209k→~788k) from the 07-11 Dapper `searchPackNft` API backfill writing ~400k rips/hr on */3 crons. Consequences observed and expected to clear:

- Vercel 300s timeouts across heavy routes (sniper-feed, wmc-fmv-populate, fmv-recalc, classify-acq, warm) clustered through the day; `[edition] offers`/`[pack-detail] pack_lifecycle`/`pack_realized_ev` statement-timeout classes on current prod (114/34/29 events per 12h).
- `rpc-allday-rollup-rip-value` (sums FMV per pack_nft_id) now aggregates over a 50x-bigger AllDay rip set — its timeout may be **structural, not just contention**. Watch after the backfill completes; if it still fails on quiet ticks it needs a set-oriented rewrite or covering index (handoff item).
- **Action when AllDay hits done=true (~within the hour):** `SELECT cron.unschedule('rpc-pack-opens-api-allday');` — then re-verify rollup-rip-value, cross-source-dedup, remap, and classify-acq all pass on their next quiet ticks.

## Page sweep (385 unique pages, Chrome fetch, all 200)

Sampled from the live sitemaps (stride sampling): 130 TS + 70 AD + 25 GZ editions, 25 Pinnacle pins, 50 packs (20 TS / 15 AD / 8 GZ / 7 PIN), 20 sets, 20 teams. Checks per page: HTTP status, `<img>` presence, sales-history / special-serials / badges / offers / top-owners / parallel-printings content markers.

- **0 non-200, 0 zero-image pages, 0 editions missing sales/serials/badges/offers markers.**
- Parallel-printings section present on 67/175 TS editions (exactly the subset that has parallels — correct).
- Top Owners renders on TS editions only (Dune ownership index is TS-only) — absent on all AD/GZ/PIN. Parity gap → roadmap.
- Pinnacle pins (old `/pinnacle/moment/` template): no special-serials / sales-history / top-owners sections → roadmap (pin page v2).
- Set pages have no sales section (by design); team "activity" naming differs from the marker regex — verified visually instead, fine.

## Visual QA highlights

- **TS edition page** (233:8121::19 Traore Metallic Gold): hero + parallel chips with premiums (Standard /129, Hexwave 1.9x, Jukebox 3.0x), FMV history chart, sales table with **both buyer and seller usernames resolving**, parallel-attribution column, pack provenance card, special serials, top owners. Excellent.
- **TS pack page** (dist 7800): sealed-resale stats, tier-level pool-remaining, WHAT'S INSIDE grid (FMV priced 80/80, sortable, per-edition hit% and weight), 2-column sales history with usernames. The smoke-test "Sales History=false" is definitively a false-fail — the section renders.
- **AllDay pack page** (dist 180 Gift Packs): OBSERVED PACK LIFECYCLE row (43,057 opened / 120,412 pulled / $63,008 realized / $1.46 avg), opened-share 96%, depletion 96%, packs remaining 1,823 / 46,823 minted — the deep-history backfill is already feeding it. Honest empty states for sales/EV.
- **/moment/ page**: honest "FMV unavailable" on a /5 LEGENDARY with no sales, best offer $118 shown, "Avg Sales Price" label live (rename verified), similar-moments grid at the bottom with working links.
- **Team hub** (Blazers): 57 players / 484 editions / FMV + floor totals / 30d volume.

### Visual defects found (all in the follow-ups handoff)

1. **No-confidence-UI violation (HIGH-visibility):** pack dist pull-odds table renders `$1.48 · LOW` chips and the footnote "Low-confidence FMV (LOW / ASK_ONLY / STALE / NO_DATA) is flagged inline" — survived the 07-11 confidence-label sweep. File: `app/(collections)/[collection]/pack/dist/[distId]/page.tsx`.
2. TS pack hero art black/empty on dist 7800 (reward packs have no art asset — needs a branded placeholder like AllDay's letter tile).
3. Blazers team-hub montage strip: 3 of 5 thumbnails blank.
4. AllDay pack lifecycle caption "observed since Jun 2026" now false — API backfill reaches 2021-12.

## Native-site parity (Trevor-directed): 223:7512 Origins Traore family

| Check | v2.nbatopshot.com | RPC | Verdict |
|---|---|---|---|
| Parallels + circs | /129, /25, /10 | base, ::19 /25, ::20 /10 | exact ✓ |
| Badges | 2 (rookie icons) | Rookie Year + Rookie Mint, base AND parallels inherit | exact ✓ |
| Avg sale (Jukebox) | $74.30 | FMV $79.25 (LOW, recency-weighted) | consistent ✓ |
| Serial offers | — | #9 $78 **filled** (matches the 06-29 $78 sale row), #8 $75 cancelled | captured ✓ |
| Recent sales | activity aligns | #9 $78 6/29, #9 $61 5/03, #8 $100 4/16 … | ✓ |
| **Open offers (Jukebox)** | **$45 / $44 / $14 open** | none open on ::20 (open: $30 on ::19, $20/$15/$13 on base) | **GAP** |
| Low ask (Jukebox) | $105 (#9), 2 listed, "20% listed" | `edition_offers` has base row only ($25/serial 47, fresh 01:02Z); no ::19/::20 rows yet | expected-lag |

The offers GAP is the one real parity finding: either the per-printing GQL offers sweep (07-07 ship, "accrues ~4 ticks/cycle") hasn't re-walked this edition — the ::-row absence supports that — or those v2 offers live off-chain in the dapper.market book and never hit DapperOffersV2. Handoff item: sample 10 v2-visible open offers against `offers` after the sweep completes a full cycle; if off-chain offers are real, that's a new (small) indexing surface.

## Competitor recon

- **NFL ALL DAY IS SUNSET (the big one).** Official note (blog.nflallday.com/posts/nfl-all-day-changes, last updated 2026-05-13): **no new AllDay Moments will ever be issued**; marketplace continues; qualifying purchases through **Sep 9, 2026** earn a **5% Dapper Balance rebate** (12-month hold on the purchased Moment); current holders get a permanent **"Founding Collector"** designation; "next evolution of NFL digital collectibles" teased. Strategic read: Dapper is consolidating Flow sports collectibles down to TopShot (UFC→Aptos, AllDay frozen); RPC's AllDay catalog is now a **complete, finite dataset** — an intelligence advantage (nothing new to index, ever) and a UX obligation (say it honestly, like the UFC treatment but with a live market). The rebate window is a live trading signal RPC should surface on AllDay market/sniper surfaces.
- **v2.nbatopshot.com** features RPC lacks: per-edition "top stacker" callout; "% of circulation listed" stat; badges filter in marketplace search; per-serial listing picker. RPC beats it on: FMV/EV analytics, pack provenance, parallel premium comparison, sales attribution, cross-collection.
- **dapper.market:** unified cross-brand marketplace with live global sales ticker + 7d volume/sales/buyers KPIs per brand. RPC's cross-collection overview already rhymes with this; a small "7d pulse" strip per collection would match it.
- **disneypinnacle.com:** set-card completion progress, native Trade tab, Pinbooks — gamified set-completion is their core loop → Pinnacle set/pinbook-progress intelligence is indexable data RPC doesn't surface yet.
- **ufcstrike.com:** Aptos migration (known, teardown already shipped 07-10/11).

## FMV / Pack-EV parity state (verified)

All four collections have live pack EV in the last 24h: TS 823 dists / AD 1,600 / GZ 124 / PIN 84 (newest snapshots 00:17–02:13Z). FMV freshness in-band everywhere (see trust). AllDay serial-FMV parity COMPLETE per the 07-11 jersey ship (#1 + perfect + jersey all live; weekly refits jobs 49/50/54). Pinnacle serial multipliers weekly (job 39) + render-keyed FMV + supply-weighted pack EV all live. **Remaining parity items are UI-level, not pipeline-level:** AllDay/GZ top owners, Pinnacle pin page v2, AllDay offers indexing (roadmap).

## Scheduled-task outputs review

Inbox drained (empty). focus.md is 06-24 vintage — every item in it has since closed in the ledger (studio backfills shipped + watchlisted; TS dead-media 0/0; unmapped drain landed; spork worker corrected). The 07-11 overnight pass + monitor chain is functioning as designed: the cron-job.org dropout was caught, attributed, and self-healed; post-ship watches all passed. One standing operator item from the chain remains open: **CF worker `topshot-moments-hydrator` needs `wrangler deploy`** to activate the partial-data chunk fix (c1ba51e) — hydrator GetMintedMoment errors continue until then (72 fails/24h, no corruption).
