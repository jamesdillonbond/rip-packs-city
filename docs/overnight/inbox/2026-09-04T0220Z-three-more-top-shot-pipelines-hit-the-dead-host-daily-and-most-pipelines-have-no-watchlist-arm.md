# Three more Top Shot pipelines still hit the decommissioned host every day, and ~80 pipelines have no cadence-watchlist arm at all

**Filed 2026-09-04 02:20Z (2026-09-03 19:20 PT) · Claude Code on Trevor's box, interactive · measured, NOT shipped — the two facts below fell out of the `sales-serial-backfill` fix (ledger 2026-09-03) and each needs a decision before code**

## 1 · The dead host is still being called by three daily pipelines

`public-api.nbatopshot.com` is decommissioned (Cloudflare 530 / error 1033 from every egress path since ~2026-08-28; the serial lane it fed was ported on-chain tonight). `pipeline_runs_daily` for the last four days:

| pipeline | caller | runs/day | ok | `last_error` (verbatim head) |
|---|---|---|---|---|
| `topshot-badge-set-backfill` | GHA `badge-sync.yml` (`15 */6`, `45 2,8,14,20`) | 4 | **0** | `Top Shot GraphQL failed with 530. Response body: <head>…An error has occured` |
| `topshot-catalog-backfill` | Vercel cron `/api/cron/topshot-catalog-backfill` | 1 | **0** | `page 0: HTTP 530: error code: 1033 \| page 0: HTTP 530 …` |
| `topshot-misattrib-drain` | **not in vercel.json, GHA or pg_cron** — cron-job.org or this box's Task Scheduler (the 7th/8th caller sources) | 1 | **0** (1 of 12 in 14 d) | `HTTP 530 \| HTTP 530 \| HTTP 530` |

These are honest (`ok=false`, error named) — unlike the serial lane they were never hiding. What they are is **wasted daily calls to a host that will not come back**, and three more pipelines whose product value now depends on the same decision as #50 and the paused jobid 16: **port to Atlas / on-chain, or pause with a stated re-check trigger.** Pausing is the 08-29 precedent (jobid 16) and is reversible; porting needs the Atlas shape for each read (`badge_editions`, the set/play catalog, the mis-attribution re-key). ⚠ Pausing the badge-set backfill also silences the only thing keeping `badge_editions` fresh for Top Shot — check what reads it before choosing.

> 🟠 **PARTLY RESOLVED, same night (ledger 2026-09-03, `topshot-circulation-onchain`):** the CIRCULATION half of `topshot-catalog-backfill` is ported to the chain (`TopShot.getNumMomentsInEdition`, base rows only, normalised compare). What the walker still did that nothing does now: tier, media URLs, new-edition creation — those are not on chain and remain the Atlas decision. `topshot-badge-set-backfill` and `topshot-misattrib-drain` are unchanged (badges are not on chain; the drain's holder-then-borrow port is the same shape as the serial lane and is the next candidate).

**Not done tonight because:** the cost is ~6 runs/day (negligible), the failure is already visible, and choosing between pause and port is a product-data decision, not a diagnosis. **Nearest cheap step if the answer is "port":** the catalog backfill's per-page shape is the closest to the serial lane's — the set/play catalog is on chain (`TopShot.getAllPlays()` / `getSetData`), which the serial lane's `runScript` helper can read without any Atlas dependency.

## 2 · ~80 pipelines with ≥7 active days in the last 14 have NO row in `pipeline_cadence_watchlist`

Expression (paste-able):

```sql
with recent as (select pipeline, sum(runs) runs, sum(ok_count) ok_runs, count(distinct day) days, max(day) last_day
                from pipeline_runs_daily where day >= current_date - 14 group by 1)
select r.* from recent r left join pipeline_cadence_watchlist w on w.pipeline = r.pipeline
where w.pipeline is null and r.days >= 7 order by runs desc;
```

Result at 02:18Z: **80 rows.** Roughly a third are `*-heartbeat` twins of watched pipelines (the heartbeat is the invocation marker; the terminal row is watched) and a handful are DB-internal (`refresh_wmc_fmv_*`, `promote_unmapped_sales`, `pipeline-runs-daily-rollup`). The rest are real pipelines that a stopped cron would silence unnoticed — the exact gap `sales-serial-backfill` sat in for a month. Names worth a first look because they are also NOT succeeding: `sync-nba-projections` (108 runs / 0 ok — that is #8), `topshot-misattrib-drain` (12 / 1), `topshot-badge-set-backfill` (49 / 24), `topshot-catalog-backfill` (14 / 8), `topshot-deal-floor-serials` (last day **08-30** — stopped?), `editions-hydrate-at-insert` + `ingest-canonical-guard` (last day **08-28**, sub-steps of `/api/ingest` — did the parent stop logging them?), `compute-laliga-pack-ev-heartbeat` (last **08-27**, renamed to golazos — a dead name, not a dead pipeline).

**Why this is a filing and not 80 `INSERT`s:** the 08-29 measurement that refuted the one-word `ok` filter found **21 of 83 arms would have flapped** under a naive rule; seeding 80 silence arms at 3× an observed gap from a 73 h window would reproduce that at scale and page Trevor's Telegram overnight. The right shape is the one the no-success arm used on 09-03 — a **data-driven seed from each pipeline's own history**, reviewed as a table before it is applied, with heartbeats and DB-internal names excluded by rule. That is a daytime change with a human reading the seed table. **Do NOT auto-ship this from the night pass.**

## Falsifiers

- §1: `select pipeline, ok_count from pipeline_runs_daily where day = current_date and pipeline in ('topshot-badge-set-backfill','topshot-catalog-backfill','topshot-misattrib-drain')` — an `ok_count > 0` means the host answered and this section is wrong.
- §2: the expression above returning < 40 rows means arms were added since and the census is stale.
