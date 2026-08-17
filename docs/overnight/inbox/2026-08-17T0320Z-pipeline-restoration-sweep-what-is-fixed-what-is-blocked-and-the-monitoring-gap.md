# Pipeline restoration sweep — 2 restored, 3 blocked on access I don't have, and the monitoring gap that let all of it run for days

Filed 2026-08-16 20:20 PT / 2026-08-17 03:20Z (Claude Code, interactive). Companion to the two ledger entries shipped alongside.

Method: ranked every pipeline in `pipeline_runs_daily` over 7 days by failure rate, then separated **genuine defects** from **saturation collateral**. Most timeouts are the documented platform-wide disk-IO saturation and are not individually fixable. What follows is the residue.

---

## ✅ RESTORED THIS SESSION (shipped, see ledger)

| pipeline | was | fix |
|---|---|---|
| `apply-fmv-haircut` | 100% fail since ≥08-14, 0 rows written, every run ~125.17 s | split per collection so each leg gets its own 120 s budget |
| `drain-fmv-cold-tail` | reported `0/0` on every run while repricing 5–71 editions/tick | populate `rows_found`/`rows_written` from the real processed count |

## ✅ ALREADY RESTORED BY SOMEONE ELSE — verified, not assumed

`compute-pinnacle-pack-ev` suffered a **3-day total outage** (08-12 → 08-14, 0 rows written) on `ON CONFLICT DO UPDATE command cannot affect row a second time` — one duplicated `dist_id` in a batch discarding the whole upsert. The repo fix (`bd53bb3a`, `_shared/upsert-dedupe.ts`) landed 08-13 15:20Z but failures continued for two more days, which looks exactly like edge-fn deploy drift. It is **not**: the function was redeployed **2026-08-15T20:27:09Z** (version 22) and the very next run at 20:27:37Z succeeded. Green since. **No action needed.**

---

## ⛔ BLOCKED — needs access or a decision I don't have

### 1. `sync-nba-projections` — 51/51 failing, all three upstreams 403, with an OCTOBER DEADLINE

Every run fails `all_upstreams_failed` after ~32 s. All three sources are blocked, not empty:

| upstream | status |
|---|---|
| DraftKings (`/lobby/getcontests`) | **403 Access Denied** — Akamai edge block (`errors.edgesuite.net`) |
| ESPN | **403** |
| scoreboard (rolling) | **403** |

⚠ **It is ALSO the NBA offseason, and that is what makes this easy to ignore into a launch failure.** Live: **zero** future rows in `nba_games` (last game 2026-08-04), newest projection **2026-07-20**. So nothing is being lost *today* — nothing exists to fetch.

**The risk is dated.** These are IP/WAF blocks against the `sports-proxy` worker's egress, and they will not fix themselves by October. If nobody acts before the 2026-27 NBA season opens, **Fast Break launches with no projections** and the discovery happens at the worst moment.

- Not on `pipeline_cadence_watchlist`, so it pages nobody.
- Fix needs a **Cloudflare `wrangler deploy`** on `sports-proxy` (UA/header work, or a different upstream) — operator-only, and unverifiable from here.
- ⚠ Worth doing regardless: make the offseason case an honest **skip** (`ok:true, skipped:"no_games"`) rather than a failure, so 4 red runs/day stop training the operator to skim — the `ufc_fmv_stale_hours` cry-wolf lesson. **That is an EDGE FUNCTION change** (`sync-nba-projections`, `import_map: true`), so it carries the documented boot-fail trap and was deliberately not attempted at the end of a long session.

### 2. `topshot-wmc-fossil-drain` — both weekly runs timed out, 0 rows

Weekly. **08-03 and 08-10 both failed** with `targets: canceling statement due to statement timeout`, 0 written, and there is no run since. Its candidate-selection step (`targets:`) is the thing dying — the same "the selection query is the expensive part" shape as the `topshot-flowty-unmapped-drain` retired today. Not investigated further; it needs its `targets` query profiled and bounded.

### 3. `ownership-sync-dune` — **HTTP 402, Dune credits exhausted**

08-10: `stale cache: refresh did not complete (execute HTTP 402)`. **402 is Payment Required** — the Dune free-tier credit budget. It degraded honestly (served 114,083 rows from stale cache rather than publishing nothing), which is the system working. But the ownership index stops refreshing until credits reset or the plan changes. **Operator/billing decision.**

---

## ⚠ THE MONITORING GAP — and it is the reason all of this ran for days unnoticed

**`apply-fmv-haircut` and `match-topshot-players` ARE on the active `pipeline_cadence_watchlist`.** They still failed 100% for 3+ days with nothing firing.

That is not a bug in the watchlist — it is what a cadence arm *is*. It watches **silence**, and both pipelines ran perfectly on schedule; they simply failed once they got there, and **a failing run still writes a `pipeline_runs` row**, which refreshes `last_run` and keeps the arm green. CLAUDE.md already records this exact lesson for `ownership-onchain-walk`: *"the cron fires perfectly and a failing run still writes a row, so every cadence instrument read healthy through the whole outage — `rows_written > 0` is the entire difference."*

**So the platform has cadence coverage and essentially no SUCCESS coverage.** The cheap closer is a single arm over `pipeline_runs_daily`: *any watchlisted pipeline whose trailing-24 h `ok_count` is 0 while `runs` > 0*. That is one indexed read, it is collection-agnostic, and it would have caught every pipeline in this filing on day one.

⚠ **Do NOT implement it as "fail_count > 0"** — that fires constantly on the saturation-class pipelines (`refresh_wmc_fmv_changed` runs at a 32.6% failure rate and is *working*, writing 409,110 rows). The signal is **zero successes**, not the presence of failures. Filing this rather than shipping it because choosing the threshold and the paging severity is an operator judgement, and a badly-chosen one adds noise to a board this repo has twice had to rescue from cry-wolf arms.

### ⚠ Design constraints measured 2026-08-17 04:55Z, before writing it — two of them kill the obvious implementation

1. **`warn` IS NOT SOFT. It notifies, and the sentinel runs HOURLY.** `app/api/sentinel/route.ts` computes `shouldNotify = hasCritical || hasWarn || isScheduledReport` and sends **Telegram + email** on that. So "just add it as a warn so it reports without paging" — my own first instinct — is wrong: a persistently-broken pipeline produces an **hourly notification until someone fixes it**. Given the arm would fire *today* on `match-topshot-players` (a genuinely broken but low-impact once-daily job), shipping it as-is buys hourly noise for weeks. **It needs a suppression story before it needs code** — the route already has a `[check disabled via config]` mechanism and a `thr()` threshold helper, which is where that belongs.
2. **`pipeline_runs` cannot be aggregated over 24 h through PostgREST.** It holds ~9.5 k rows over ~73 h, so a 24 h window is ~3 k — **over the 1000-row cap**, which would silently truncate and make the arm under-report (the documented cap trap). The alternatives: read **`pipeline_runs_daily`** and accept that it is a **six-hourly** rollup — in which case the detail MUST state its `refreshed_at` age, per the standing rule never to read that table's recency without it, and a recovered pipeline can read broken for up to 6 h — or add a small aggregating RPC, which turns this from a route change into a migration.

**The `Ownership Index Freshness` check (`app/api/sentinel/route.ts:374`) is the template to copy** — same gap, one pipeline wide, and its header already documents the mechanism ("the cron fired exactly on time and a FAILING run still writes a `pipeline_runs` row"). This arm is that check generalized to every watchlisted pipeline. ⚠ **Scope it to `pipeline_cadence_watchlist` where `is_active`** — that inherits the operator's existing curation of what is worth watching, so it cannot fire on something nobody chose to monitor.

---

## Verified NOT defects (recorded so nobody re-derives them)

- **`pinnacle-listings-retry`** — finds exactly 100 every run, writes 0. Its query correctly excludes capped rows (`.lt("retry_count", 10)`) and the pool self-retires; it is grinding the documented Pinnacle catalog-coverage gap at ~13 min/day, resolving 7.7%. Working as designed.
- **`topshot-pack-opens-history-backfill`** — `done:true` ~96×/day is the **deliberate standby** CLAUDE.md says not to unschedule.
- **`ufc-sales-indexer`** — 0 rows is correct; the UFC market has been closed since May 2026.
- **Dispatchers/heartbeats/MV refreshers** (`wallet-backfill-multicollection-dispatch`, `alerts-send`, `fmv-recalc-heartbeat`, `refresh-pack-grail-metrics-mv`) legitimately write 0 to a counted table. ⚠ **`rows_written = 0` is a null instrument** — read `extra` before concluding a pipeline does nothing. `drain-fmv-cold-tail` is the proof: this same sweep ranked it as inert waste, and it was repricing FMV the whole time.
