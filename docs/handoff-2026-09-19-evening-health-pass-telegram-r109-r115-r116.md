# Handoff — 2026-09-19 ~5:30 PM PT · evening health pass: the pager's Telegram channel, R109's decisive test, the confidence precompute, `portfolios`

**Session:** Cowork cloud + laptop VM, Trevor-directed ("run a health check … address as many issues as you can"). **Push:** path A (laptop VM, `.rpc-git-cred`) — proven by `ls-remote == HEAD` on `d1c11a79c`. All times **PT**.

> ⚠ Any push-capability note in this file is specific to **this cloud session**. Trevor's machine and Claude Code push normally via Git Credential Manager. **Commit the migration files as usual.**

## Health verdict — the board reads worse than the estate

**HEALTHY since noon.** Every `high`/`medium` `failure_rate` row on `get_pipeline_alerts()` straddles this morning's IO spell (a 2-day window). Split on the change point:

| instrument | before noon | since noon (5 h) |
|---|---|---|
| `cron.job_run_details` failures | 30–108 / h | **0** (~405 runs/h, every one `succeeded`) |
| `pipeline_runs` fail rate | 1.85 % (157 / 8,502, 12 h) | **0.31 %** (11 / 3,589) |
| `rpc-ts-listings-atlas-sync` (R101) | 257 fails / 24 h | **161 / 161 ok** |
| backfill-pack-rip-metadata · fmv-backfill · lock-check-batch · run-insider-detectors · allday-buyer-backfill | 63 % · 50 % · 45 % · 44 % · 33 % failing (2-day) | **5/5 · 2/2 · 11/11 · 5/5 · 2/2 ok** |

Security 0/0/0/0 · stalled pipelines 0 · the three Atlas lanes are active again (the thread-close handoff's item 1 — resolved before this session, no entry names who). Sentry: nothing in 24 h, **paired with Vercel: 50 groups / 24 h, all long-standing shapes, newest 4:47 PM PT** — the `[pack-detail] … read exceeded 5000ms` family (1,421 / 24 h on `/[collection]/pack/dist/[distId]`) still fires post-noon and is the next user-facing cost; **not addressed here**.

Two trust breaches at write time: `trust_precompute_max_age_hours` 23.2 h (jobid 324 runs at 5:48 PM PT — see watches) and `public_board_slow_count` 2 (an instrument memory says lies; not chased).

## Shipped (4 items)

1. **Telegram delivery restored + the class closed** — `d1c11a79c` (CI green) + a prod data repair. The pager's Telegram channel was dark **12:04 PM → 5:07 PM PT** because the `Cadence Collapse` ack reason (written 9:13 AM PT, expiring 10-01) contained `baseline_per_day < 400`, interpolated raw into a `parse_mode:"HTML"` message. Email still delivered. Data: `< 400` → `below 400`. Code: `escapeTelegramHtml()` + `renderSentinelTelegramLine()`, test reproduces the live fragment. ⚠ `lib/ops-alert.ts` has the same exposure and is **not** changed (callers may pass intentional markup) — queued.
2. **R109 decisive test** — `step1` **25.0 s**, `step2` **30.4 s**, `daily-portfolio-snapshot`'s aggregate **5.2 s** (read-only) on a quiet box with `wallet_moments_cache` `relallvisible` = 1.000. The 600 s / 300 s / 120 s kills were the estate, not the statements. **Both cross-collection mats are fresh; the staleness guard reads [].** Probes 528/529 unscheduled.
3. **R115 + R116** — migration `20260920001632`: jobid 506 gets `SET statement_timeout = '300s';` (jobid kept), the loop derives its collections, Pinnacle reads `pinnacle_fmv_history`, `coalesce('{}')` gone, `rpc_ops_snapshot()` derives its two keys and adds `fmv_by_collection_note`, the function writes `pipeline_runs`. **Control run: 6 rows, Candy 62.4 %, Pinnacle 28.0 % — the filing's falsifier to the decimal.** Structural half of R115 (78:1 DISTINCT ON) still open.
4. **`portfolios` anon write grant revoked** — migration `20260920001811` (thread-close item 5). Anon write-grant set now reads exactly 4, all INSERT-only.

Ledger entry (top of `docs/overnight/ledger.md`) carries revert paths for all four. Register rows R109 / R115 / R116 updated; `check-register-integrity` green.

## Watches (exit · falsifier)

- **jobid 324 `rpc-thp-leg-impossible-parallel`, 5:48 PM PT** — exit: `trust_precompute_max_age_hours` < 13 · falsifier: a 600 s kill on a quiet box means the leg's own cost moved (it was 35–52 s on 09-18/19 00:48Z).
- **jobid 506, 6:35 PM PT** — exit: `succeeded` under 300 s, `nba_top_shot` `duration_ms` well under 200,000.
- **step1 at 3:02 AM PT** — read `relallvisible/relpages` for `wallet_moments_cache` at ~3:00 AM first; exit `succeeded`; a kill with the map still ~1.0 re-opens contention as sole cause.
- **jobid 490 at 4:17 AM PT** — a new `portfolio_snapshots` row (second half of the `portfolios` exit).
- **Next sentinel sweep** — `notifications` contains `telegram`, not `telegram-FAILED`.

## Second half of the pass (5:45–6:10 PM PT) — verified, then shipped two more

- ✅ **Telegram is back.** The 6:04 PM PT sentinel sweep recorded `notifications: ["telegram","email","github-actions-native"]` against `telegram-FAILED` on every sweep since noon. (The `Alert Delivery` arm still reads warn for a while — it inspects the last 12 attempts.)
- ✅ **`trust_precompute_max_age_hours` 23.2 h → 5.09 h (ok).** Watched the 5:48 PM PT tick: leg 324 and jobid 65 (`rpc-allday-ev-corrected-refresh`, `47 */6`, the same four hours) ran together, drove the box from io_wait 0 to 7, and finished at 272 s / 374 s — survivors only because nothing else contended; on 5 of 6 shared ticks since 09-18 both died at 600 s. **Shipped `20260920005312`: leg 324 moved `48 → 31 0,6,12,18`** (measured least-loaded minute; the old "healer 219 must run before 324" ordering is moot — 219 was retired 09-12). Exit: the 11:31 PM PT tick tonight, then 5:31 AM / 11:31 AM PT, `succeeded` with the arm under 13. ⚠ **Corrected 6:45 PM PT (Claude Code, Windows box): this line first read “6:31 AM / 12:31 PM PT”, which is an hour off.** `31 0,6,12,18` is UTC; PDT is UTC−7, so the four ticks are 5:31 PM / 11:31 PM / 5:31 AM / 11:31 AM PT. The 00:31Z tick (5:31 PM PT) fired BEFORE the migration applied at 5:53 PM PT, so the first tick under the new schedule is 11:31 PM PT tonight — not a morning one.
- ✅ **`lib/ops-alert.ts` escaped too** (`3b884ec23` on main) — its callers pass data-built plain text (the smoke-test detail carried `<!DOCTYPE html>` during the 09-18 outage). Two other `parse_mode:"HTML"` senders (`alerts-send`, `detect-league-drift`) are **not audited**.
- 🧾 The `[pack-detail] read exceeded 5000ms` family is 25 in the 5 h since noon (1,421/24 h), and the survivors are mostly the smoke fixture `dist/5048` with `cache=BYPASS` every ~10 min. `get_pack_lifecycle_row('5048')` is 19 ms warm / 2.0 s + 3,441 physical reads cold — IO, not the query. Not fixed.
- 🚫 `pg_visibility` cannot be installed (superuser only) — thread-close item 6 closes as unreachable.
- Sentinel at 6:04 PM PT: **CRITICAL on one arm only** (`Pipeline Success Coverage`: daily-portfolio-snapshot / golazos-buyer-backfill / match-topshot-players — all 24 h-window readings from the night spell; the first two re-test at 4:17 AM PT and their own next ticks, the third retries Saturday). Warns: Alert Delivery (lagging), Detector Health (acked), Dune (configured stop), pg_net #75, Golazos 0 sales/7d (market), `public_board_slow_count=2` (instrument), Wall Kills, Zero-Yield.

## Needs Trevor (unchanged from the morning, plus one)

#22 purge residue · #55 the two 2-hourly Routines · #75 pg_net response store 10.2 GB (VACUUM FULL) · jobid 303 `refresh_wmc_fmv_changed` as the #1 reader · R107 (both fixes change prices users read) · **new:** whether to retire `portfolios` + `portfolio_moments` outright (option b), now that the grant is gone.

## Not done, deliberately

the two un-audited `parse_mode:"HTML"` senders (`alerts-send`, `detect-league-drift`) · the `[pack-detail]` 5 s read timeouts · R115's watermark rewrite · R107's full reconcile (needs the cold measurement and Trevor) · backfilling the missed `portfolio_snapshots` days (product call).
