# Handoff — 2026-09-22 daytime autonomous pass (Cowork cloud + laptop VM, 11:28 AM → ~4:30 PM PT)

**Push status:** every commit this pass landed on `main` through the laptop VM (`$HOME` clone + the `.rpc-git-cred` store helper), built and tested in the cloud clone first. ⚠ The cloud container itself cannot push — *"not in this session's authorized repository set"* — which is specific to **this cloud session**. Trevor's machine and Claude Code push normally via Git Credential Manager. **Commit files as usual.**

## Health verdict: GREEN, with two defects found and fixed

- Cron fleet on LARGE: 24 h `cron.job_run_details` **9,481 / 9,481 succeeded, 0 startup timeouts**; 6 h failure rate 0 / 2,359.
- Security: `check_public_security_invariants` 0 rows, anon-write surface 0, secdef drift `[]`, search_path drift `[]`, R118 blind handlers 0.
- `detect_stalled_pipelines`: only `topshot-active-listings-ingest` (the laptop had been asleep; it resumed 11:16 AM, browser mode, 0 skipped).
- Vercel 24 h: 19 error groups, all low-count. `[pack-detail] … read exceeded 5000ms` still fires a handful of times (7 / 6 / 4 …, 1–2 users, mostly 7–9 AM PT) on a calm instance (6–9 MB/s, 93–95 % cache hit). See watch item W3.
- Sentry isn't used any more (#34), so it wasn't read.

## Shipped

| # | What | Where | Verified | Revert |
|---|---|---|---|---|
| 1 | **AllDay pack EV: `get_fmv_for_editions` chunked under PostgREST's 1000-row cap; pool prune by run stamp** | `compute-allday-pack-ev` v59 (v10 source; the repo copy was reconciled by the Claude Code session, `ef84e5d`) | First run: editions_with_fmv 1,000 → 1,463, EV rows 18 → 23, pool errors 1 → 0; **the page cursor advances again** (it was stuck on page 1 for ~37 h) | redeploy v58 from `edge-drift-2026-09-22` rollback copy |
| 2 | Same class closed at every other call site; tree-walk guard added | Golazos v35 (deployed), TopShot pack-EV (source only, no caller), `/api/wallet-cost-basis`, `__tests__/get-fmv-for-editions-is-chunked-under-max-rows.test.ts` | Golazos 11:37 run ok, v3; planted defect reds 4 guard cases | `git revert a5ded5f1d`; Golazos → v34 |
| 3 | **#35 write half: `suppress_redundant_updates_trigger()` on both `*_pack_sales_history` tables** | migration `20260922193435` | `n_tup_upd` +0 for 20+ min post-ship (was ~1,000–1,400/min); walker kept writing `err:null` | `DROP TRIGGER trg_suppress_redundant_updates ON …` (both) |
| 4 | Zero-Yield: 2 correct zeros suppressed with on-chain positive controls | migration `20260922194626` | offenders 4 → 2 (the two alert lanes stay loud on purpose) | `DELETE … WHERE pipeline IN (…)` |
| 5 | Five Cowork skills refreshed; `rpc-surface-qa` brought into the repo + bundle guard; CLAUDE.md "Supabase (Pro, Small)" → Large | `docs/cowork-skills/*`, `CLAUDE.md` | bundles 11/11, docs-guard 157 files green, CLAUDE.md 39,952 chars | `git revert` |
| 6 | Ledger backfill: the 09-21 Small→Large verdict and the 09-20 job-44 rotation (both lived only in Project docs) | `docs/overnight/ledger.md` | swallowed-headings 3, future-dated 0 | — |
| 7 | **All Day floor view excludes listings whose NFT sold after listing (Trevor-approved)** | migration `20260922205752`, table `allday_listings_sold_after_listing`, pg_cron job 596 | floors 4,543 → 4,381, full read 5,127 → 5,274 buffers, invariants 0 | in the migration header (unschedule, old view body, drop fn and table) |
| 8 | Two follow-ups to #7's refresher. The first cron runs took 18–25 s at 757k buffers per call: an INSERT plans serially and hashed every All Day sale. The collection literal is now inlined (harmless, not the fix), and the probe is a per-listing `LATERAL … LIMIT 1` | migrations `20260922210944`, `20260922214635` | 330–465 ms per call; positive control: 5 deleted ghosts re-found as 5 | re-apply the earlier body |

⚠ **I broke CI once and fixed it:** `9e17d91e6` (docs-only) moved a paragraph between a `<!-- retired-rule:allow -->` marker and the line it allows → "Docs-guard tests" red. Fixed in `06500b3a5`. After that I ran the docs-guard set locally before every docs push.

## Needs Trevor (decisions, not code)

0. ✅ **SHIPPED on your approval (~2:00 PM PT): All Day FMV was capped by ghost floor listings.** 55 % of All Day HIGH and 44 % of MEDIUM editions (7+ sales in 30 days) had an FMV **below every one of their last 7 sales**, while Top Shot is symmetric at 1.00. 180 of those 184 had FMV exactly equal to `allday_edition_floor_ask`, and 722 of 740 contradicted floors were NFTs that had **sold after the listing was created**, so the listings were dead. The fix is migration `20260922205752`:
   - `allday_edition_floor_ask` now excludes those listings via a small set table, which pg_cron job 596 refreshes every 15 min.
   - An inline anti-join would have cost 27× buffers on every full read, so the probe runs in the job instead. Full reads are +3 %.
   - Floors went 4,543 → 4,381.
   - This also corrects the All Day deal board and badge low-ask, which read the same view.
   - The FMV before/after is in "All Day before/after" below.
   - Write-up: `docs/overnight/inbox/2026-09-22T2045Z-…`.
   - The route-level alternative (skip the cap when ≥3 sales cleared above the ask) was built and tested but **not committed**. It is redundant with the source fix, and it would be FMV route logic.
1. **Deal alerts are nearly unable to fire on Top Shot.** Your two active subscriptions (Blazers rookie specials ≥25 % under FMV; Lillard Archive ≤ $0.60) have delivered nothing since 09-14. The gate is correct (an ask must be confirmed within 12 h), but only **1,485 of 13,154 Top Shot asks (11 %)** are that fresh. The median ask is **126 h old**, because Atlas is the only thing confirming Top Shot asks since `public-api.nbatopshot.com` died. The choice is widening Top Shot ask confirmation (more Atlas coverage) or accepting that alerts only cover about 11 % of editions.
2. **Candy MLB confidence fell from 78 to 27 HIGH+MEDIUM** (of 125 editions) between 09-19 and 09-22, while sales **rose** (87 / 154 / 60 a day). 90 of the 98 LOW editions have ≥7 sales in 30 days. They are LOW because of the **dispersion gate**: median CV is 0.50 and prices vary about 16× within an edition. The 09-19/20 flood of cheap sales (average $1.31) widened the price ranges. That is the gate working as written. ⚠ **Follow-up measurement (1:30 PM PT), which refutes my first guess:** the dispersion is not just a 30-day trend artefact, because the **last 7 sales alone have a median CV of 0.53** (only 8 of 90 editions would clear the MEDIUM bar on them). So LOW is honest. What IS worth a look: on those 90 editions **FMV sits a median 18 % above the median of their last 7 sales**. Example: Corbin Carroll COMMON /250 has an FMV of $0.96, and its sales slid from $1.44–1.48 in late August to $0.50–0.93 by 09-16…09-20. That is lag in a falling market, which bears directly on the accuracy gate. I didn't ship anything here because pricing logic is off-limits to autonomous passes.
3. **Scheduled tasks.** The two disabled every-2-hours passes (`trig_018Ay…`, `trig_01AZz…`, disabled since 09-01, #55) should be deleted or re-enabled. They're dead weight as they are. The nightly pass is still running cloud-only without the repo attached: the 09-22 overnight flags only reached `main` because you landed them by hand. Recreating it device-bound, or with the repo attached, would let it push.
4. **Eleven legacy desktop-only Cowork dashboards** (the KPI ones `rpc-tracked-fmv-confidence` and `rpc-traction`, plus `rpc-live-health`, `rpc-qa-scorecard` and seven others last touched June–August). They can't be updated from a cloud session. The offer: consolidate them into one published "RPC Gate Board" (accuracy KPI + WAU + health) and retire the rest.
5. Still open from 09-21: jobs 22 / 25 / 27 / 29 hold literal keys (25 and 29 share one), and they need the de-literalise path.
6. **Top Shot pack sales reach the DB ~8 h late** (mechanism measured, see the W1 note). The fix is a head-first page in `backfill-topshot-pack-sales` / `backfill-allday-pack-sales`. That is an edge-function change on the two literal-key jobs from item 5, so it should ride with the de-literalise work rather than ship ahead of it.

## All Day before/after

Measured at 2:25 PM PT, about 25 min after the fix, from `fmv_snapshots`. `edition_fmv_current` lags the snapshots, so it was not used.

**Paired test on the same editions.** These are the 83 All Day editions with ≥7 sales in 30 days that fmv-recalc re-priced after the fix. Each one's last pre-fix snapshot is compared with its latest post-fix snapshot, against a last-7 median that uses only sales from before the fix:

| | pre-fix | post-fix |
|---|---|---|
| median FMV ÷ last-7-sale median | **0.667** | **1.017** |
| FMV below ALL of the last 7 sales | **59** of 83 | **6** of 83 |
| FMV above ALL of the last 7 sales | 0 | 2 |

**Re-measured at 3:40 PM PT with more of the walk done:** **n = 177** of the 521-edition population, ratio **0.650 → 1.030**, below-all **121 → 10**, above-all **0 → 3**. HIGH+MEDIUM **129 → 128** on these well-traded editions. So on editions with ≥7 recent sales the confidence cost is about nil, and the demotions below fall on thinner editions.

The Top Shot control on the same instrument sits at 1.000. All Day now looks the same: centred, with errors on both sides. Across those 83 editions FMV rose $9.63 in total (these are cheap commons).

⚠ **The price of that accuracy is confidence, and you should know it.** Across all 336 All Day editions re-priced so far, **42 went MEDIUM → LOW and 20 went LOW → MEDIUM, a net loss of 22 HIGH/MEDIUM editions.** In the two pre-fix hours the same measurement showed 11 down and 12 up, so the loss comes from the fix and is not normal churn. The mechanism: All Day ask-corroboration (09-09, `lib/fmv-confidence.ts` `escalateConfidence`) lifts LOW → MEDIUM when a live ask agrees with the sales median. The ghost floors "agreed" because FMV had been capped *to* them. So those MEDIUMs rested on a listing that could not be bought, and LOW is the honest reading. Expect the All Day HIGH+MEDIUM count to drift down as the walk completes. **That is the KPI getting more truthful, not less accurate.** Separately, 162 editions had only ghost listings, so they now have no floor: 50 of them are MEDIUM, 58 LOW and **54 ASK_ONLY**. Those 54 were priced from a dead listing (floor × 0.90), and what fmv-recalc does with them on its next pass is worth one look.

## Watch items for the next pass

- **W1 note (checked 3:40–4:15 PM PT). Top Shot pack sales lag ~8 h by design; the trigger is not the cause.** `n_tup_ins` on both pack-sales tables was flat all afternoon, and the newest Top Shot pack sale ingested at 8:40 AM PT. The trigger shipped ~12:35 PM, after that, and it only suppresses no-op UPDATEs. The cause is the walker's cycle, observed end to end:
  - Job 29 pages the entire 594k-row history at 4,000 rows per 3 min (`total_api` 42,624 → 2,621).
  - It hit `hasNext:false` at 3:58 PM and then answers `{"done":true}`.
  - `pack-sales-cursor-unlatch` reports it `was_latched:true` and resets it after `latched_minutes:30`, so the next reset is the ~4:33 PM run.
  - The walk then restarts from the head, where new sales land.
  - So a new Top Shot pack sale waits for the whole sweep (~7.5 h) plus 30 min before ingest.
  
  **Falsifier for the next pass:** rows with `ingested_at` after ~4:35 PM PT and `block_time` after 8:10 AM PT. This is the open "pack-sales head-check" filing, now with the mechanism measured. A head-first page on every run, before the sweep page, would cut the lag to about 3 min.
- **W1 (24 h exit of #3):** maps were reset to **100 %** at 1:06–1:07 PM PT by two one-off `VACUUM (ANALYZE)` jobs (5.6 s / 6.0 s, unscheduled after). Then: `n_tup_upd` on both pack-sales tables < 10 % of pre-ship; `n_tup_ins` keeps pace; `relallvisible/relpages` > 80 % after the next autovacuum. Falsifier: inserts stall ⇒ drop the triggers.
- **W2:** `get_pack_sales_history` baseline is **mean 195 ms, 141 blocks/call** (pgss, cumulative). Re-read after the visibility maps recover. The pack-detail 5 s timeouts may ease with them.
- **W3:** pg_net shows 55 s **DNS-resolution hangs** at 2–6 an hour since ~8 AM PT (the #122 class, low rate).
- **W4:** the AllDay pack-EV cursor must keep advancing, with distinct dists per hour well above 18.
- **W5 (the ghost-floor fix):** job 596 `rpc-allday-ghost-listings-refresh` should run in **under 1 s** (330–465 ms manually after `20260922214635`). Confirm it from `cron.job_run_details` duration, because the earlier runs took 18–25 s. Its first three runs inserted **0** new ghosts on a set of 17,578, so the 17.6k look historical and the live listings lane may already close sold listings. If `inserted` stays 0 for a week, the set is a one-time cleanup and the job can move to hourly. Re-run the paired FMV ratio once the All Day walk completes: the target is a median near 1.0 with both tails populated. Also watch the All Day HIGH+MEDIUM count: an honest drop is expected (see "All Day before/after").
- R1/R2 (autovacuum 0.1 → 0.02 on the pack-sales tables) are **withdrawn**. #3 removes the churn that made them look necessary. R3/R4 are still candidates.

## Triage of the 14 inbox filings from 09-19 to 09-21

Ten are resolved or were overtaken by the Small→Large resize. Still open and DB-only: the Golazos `pack_distributions` defaulted zeros (latent, not user-visible) and the pack-sales head-check (gated on a 24 h Large baseline).
