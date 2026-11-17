# Handoff — 2026-08-29 evening pass (Cowork, desktop-VM, WITH git)

**Pass window:** 2026-08-29 23:29Z → 2026-08-30 ~01:20Z (16:29 → 18:20 PT). Trevor present and answering.
**Repo state:** opened at `e929bbe43` (mount) / `c537b390d` (origin); pushed **`8281ccb`, `d262e8b`, `2307184`, `bba19b1`, `0e07dde`**. A concurrent Claude Code session pushed ~10 commits alongside.
**DB clock:** `select now()` = 23:29:13Z at open; shell `date -u` 23:29:11Z. No skew.

> ✅ **This session COULD push** — GitHub device-flow token from the desktop VM, and with Trevor's explicit approval the token is now persisted at `<repo>/.rpc-git-cred` (gitignored) so future desktop-VM Cowork sessions push without a per-session approval. Recipe: `docs/reference/tooling-gotchas.md` → "Cowork DESKTOP-VM sessions CAN push". ⚠ Cloud Cowork sessions are still repo-set 403; the scheduled 2-hourly pass prompt was updated to say so and to stop re-deriving what this pass shipped.

---

## SHIPPED (6 migrations, 1 cron-job.org edit, 1 test fix, 1 credential, docs) — all committed, CI green at `8281ccb`, drift ZERO

| what | version / ref | verified from outside |
|---|---|---|
| **Leaderboard collection push-down** — `analytics_sales_leaderboard` reads base tables; predicate on long-form `sales.collection` (Index Only Scan); `is_returning` = per-row EXISTS | `20260829234203` | ufc 41,361 → **2,194** buffers (25.8 s → 59 ms); topshot 162,717(+6,665 temp) → **27,642** (43.6 s → 11.6 s); EXCEPT-equality on 3 param sets; ACLs unchanged; drift 0 |
| **13 drifted Cowork migrations committed** byte-exact via `scripts/recover-fileless-migrations.mjs` | 050847 … 202158 | 14/14 md5-verified against prod (then 5 more) |
| **jobid 380 → 383** `maint-vacuum-sales-hot-partition` re-owned to `cron_heavy`, `53 10,20 * * *` | `20260829235254` | `cron.job` read; first tick 10:53Z is the watch |
| **Grail MV refresh → pg_cron jobid 384** via `run_refresh_pack_grail_metrics_mv_job()` (catches cancel → `ok=false` row); cron-job.org 7619844 **Inactive** | `20260829235752` | manual run 17.4 s; **first real tick 00:23Z: succeeded 39 s, terminal row ok** |
| **jobid 198 log purges** `54 9` → `46 11` (09Z = 191 startup timeouts / 7 d); grail watchlist note | `20260830000048` | `cron.job` read |
| **Board sweep slots** 288/290 `*/6` → `0,6,11,20`; probe window 480 → 600 | `20260830000303` | **00:28Z sweep 14 s; probe 45/45, slow 0, `budget_exhausted` false** |
| Leaderboard function-comment addendum (the "do not revive EXISTS" line is superseded) | `20260829235326` | comment read back |
| **Clock-dependent test** `seo-jsonld-ask-age` compares a DATE as a date; elapsed fixture 31 h → 48 h | `0e07dde` | old test fails at faked 00:16Z, new passes at 00:16/12:59/19:30Z |
| Nightly-pass scheduled prompt updated (items 4/5/8/9, drift, CI state) | trigger `trig_0142RY…` | re-read via list |
| Docs: roadmap-status block (Top Shot **39.9%** on an unchanged 19,742 denominator, +278 HIGH/MED), known-issues **#49 #50 #51**, register R25/R29 note, cron-schedule.md, tooling-gotchas | `bba19b1`, `2307184` | — |

## HEALTH VERDICT (live reads 23:29Z–01:00Z)

| check | reading |
|---|---|
| `check_secdef_anon_execute_violations()` | `[]` (value, not count) — before AND after every migration |
| `check_secdef_anon_exec_drift()` | length 0 |
| `detect_stalled_pipelines()` | 1 at open (`weekly-db-maintenance`, cause = 09Z storm, now rescheduled) |
| `get_pipeline_alerts()` | 11 rows: Top Shot upstream 530/1033 family (not ours), `pg_net_http_422` HIGH = self-inflicted (#51) |
| Sentry | zero issues — and still dark since 08-18 (#34), so zero is not evidence |
| Vercel 5xx by route, 12 h | wallet-backfill-allday 74 (known kill class, #48) · /api/market 37 · leaderboard 20 (pre-fix) |
| Surface QA (Chrome, anon) | home, squeeze (200 rows), edition, pack/dist 4184 + 901, pack-sniper (84 rows, both API legs 200/50 deals, 168 served drill-downs, OG png), moment, pinnacle render — **zero console errors**; home now has canonical + `og:url`; telemetry 204 |
| Pack-reality "Honest +EV ranker" | **2 rows, draining to 0 within ~20 h** — #50 |
| `fmv_sweep_wedge_hours` | 5.77 at the sentinel's 21:53Z read → **0.09** (page 0 completed 23:15Z after 8 saturation-band failures) |

⚠ **Not done / caveats.** The Cowork artifacts folder (`C:\Users\TDill\Claude\Artifacts`) could not be granted to this session and no artifact-listing tool is exposed here — the artifact half of the surface QA was NOT run. `resize_window` reports success but `innerWidth` stays 1920 — mobile width was not actually tested. Analytics pages are magic-link gated, so the leaderboard's real-caller check is the E2E sweep (`17 */4` → 01:17Z), read from Vercel logs.

## NEEDS TREVOR

1. **#50 pack-reality source.** The top-EV ranker reaches zero rows within ~20 h; no pack-ask source is alive (Studio has no replacement; legacy endpoint 530s). Product decision: retire the block honestly, or fund a new ask source.
2. **`topshot-active-listings-ingest` GHA is 12/12 red** (Atlas WAF block, #20) — operator wrangler/proxy work. A permanently-red workflow is a broken instrument; if it cannot be fixed soon, disable the schedule.
3. **Sentry dark since 08-18 (#34)** — operator.
4. **`REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon`** (146 tables; latent) — still your call.
5. **Six wallet-backfill HIGH arms at a 420-min threshold that the measured cadence exceeds most evenings** — re-derive `max_silent_minutes` from the distribution (prompt thread 7).

## WATCHES (exit + falsifier, all registered in the ledger)

jobid 384 at :23 (24/24 terminal rows; falsifier `57014` rows) · jobid 383 at 10:53Z/20:53Z (succeeded < 600 s; falsifier 57014) · jobid 288 at 06:28/11:28/20:28Z (probed 45/45; falsifier a truncated 11Z/20Z sweep) · jobid 198 at 11:46Z (one `weekly-db-maintenance` row) · leaderboard: next ten-wide sweep 10 × 200 (falsifier: a timeout with the map fresh → contention; NULL-collections leg is the next lever).
