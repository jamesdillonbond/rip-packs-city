# Claude Code handoff — everything still open after the 2026-08-01 audit + fix wave

**Measurements in this doc were taken live 2026-08-01 19:45 PT (2026-08-02 02:45 UTC)** via read-only Supabase MCP against project `bxcqstmqfzmuolpuynti`, plus direct file inspection. Where a figure differs from the source handoff or the ledger, **this doc's number was re-measured and the older one is wrong** — every correction is called out inline and again in "Premises that did not survive verification".

---

## ⚠ DRAIN STATUS — re-verified live 2026-08-02 10:13 PT (17:13 UTC), Claude Code

**Every CLAUDE-CODE-SHIPPABLE item in this doc is already CLOSED.** Do not re-derive them. Verified against live DB + `git log`:

| # | Status | Evidence |
|---|---|---|
| 2 | ✅ **CLOSED** | both watchlist rows `is_active=true`; `detect_stalled_pipelines()` does not list either |
| 3 | ✅ **CLOSED** | `db-pin-staleness.yml` now ENFORCES (`f322aadf`); first dispatch checked 90 pins, 90 clean |
| 5 | ✅ **CLOSED** | `mv_topshot_perfect_mint_premiums_board` + `mv_topshot_pack_reality_dist` both exist (`358b6850`) |
| 6 | ✅ **CLOSED** | option 2 taken — `breach_at` is now **99.5**, value 96.1, `ok` |
| 7 | ✅ **CLOSED** | `9871dcc2` un-broke `?specialSerials` on the legacy market path |
| 8 | ✅ **CLOSED** | `33b207e3` promoted `edge-deno` to blocking, 16 errors → 0 (root cause was a missing `--config`, **not** the toolchain conflict this doc records) |
| 9 | ✅ **CLOSED** | `05446863` re-landed the 16-module deletion, paid for with coverage |
| 10 | ✅ **CLOSED** | `09c55e75` deduped 3,074 rows via a new canonical resolver |
| 11–14 | ✅ **RULED** | rulings recorded in the ledger by `474cd8f3` |
| 1, 4 | ⏳ **OPEN — OPERATOR-ONLY** | but **item 4c is WRONG as written — see the correction in §4 before touching the console** |

**Live state supersedes this doc's "nothing is paging" line.** As of 17:13 UTC an **IOPS-saturation window is still active** (13 of 18 active queries in `IO` wait). Two trust metrics breach and two crons have dropped ticks:

- `public_board_slow_count` = 1 — **FALSE BREACH, no action needed.** The offender is `candy_holder_board` at 16,626 ms, but that probe ran at **14:52:57Z**, 2.6 minutes *before* `mv_candy_holder_board` was materialized at 14:55:36Z. Measured just now the board returns **407 rows in ~0 ms** against its 3,000 ms budget. Same stale-reading class as the `board_mv_refresh_stale_hours=999` false positive already withdrawn in `f407ee16`. It self-clears on the next successful `rpc_trust_health_precompute_refresh` (`58 */6 * * *`). **Deliberately NOT force-refreshed** — the refresher's leg 8 is a 45-view / ~64 s sweep, and on `budget_exhausted` it writes **999**, so running it inside an active IOPS window risks manufacturing a far worse false breach than the one it would clear.
- `unmapped_resolution_backlog_max` = 100 at `breach_at` 100 — known draining class, already flagged "do not re-flag" by the monitor.
- `pinnacle-sync` reported silent ~31 h — **FALSE stall, an observability gap, not a dropout.** It *ran* today: `pinnacle_fmv_history` holds **1,936 rows written at 10:07:13.742Z**, exactly on schedule. It executed and wrote no `pipeline_runs` row, so `detect_stalled_pipelines()` reports a stall for a pipeline that did its work. (`pipeline_runs_daily` also has no 08-02 row, confirming nothing was logged rather than logged-then-pruned.) ⚠ **DURABLE: for a pipeline reported silent, check the DESTINATION TABLE before calling it a dropout — "did not log" and "did not run" are different failures.** Credit to the concurrent Cowork ledger entry that caught this first; my own first draft had it wrong.
- `classify-acquisitions-multicollection` silent ~13 h (hourly at `:06` through 04:06Z, nothing since) — this one has **no** destination-table evidence of running, so it is a genuine cron-job.org dropout. OPERATOR (external console).

### Known-stale monitoring text (documented, deliberately NOT edited)

`v_rpc_trust_health`'s `catches` string for `public_board_slow_count` still reads: *"TRUE FINDING carried by this arm from day one: `topshot_perfect_mint_premiums_board` runs 14.8s warm and `topshot_pack_reality_dist` 8.4s."* **Both were materialized on 2026-08-02 (`358b6850`) and are now MV-backed** — that finding is closed, and the text will send the next auditor chasing it.

Not fixed here on purpose: the string is embedded in a large view definition whose only repair is a full `CREATE OR REPLACE VIEW` (which also wipes `reloptions`, so `security_invoker` must be re-asserted in the same statement). `v_rpc_trust_health` is what `/api/sentinel` reads, so a botched rewrite takes monitoring dark — a bad trade for a comment, especially during an active IOPS window. Fix it in a quiet window, or fold it into the next legitimate edit of that view.

---

## Context

The 2026-08-01 wave (one Cowork platform audit + ~10 interactive Claude Code sessions) shipped ~20 changes: a P0 credential sanitization, 5 IDOR closures, two anon-read revocations, 8+ prod DB migrations, 2,781 un-hidden pack pages, the Vercel-cron migration of two tick-dropping GHA schedules, the homepage `<h1>` rewrite, and 20 new DB-invariant pins (66 → 85). **All of that is done and must not be redone** — see "Already done today" below.

This doc covers only what is **still open**. It has three classes:

- **OPERATOR-ONLY** — Trevor must do it; Claude Code structurally cannot (git history rewrite, repo secrets, an external console).
- **CLAUDE-CODE-SHIPPABLE** — a session with this repo + push can ship it.
- **DECIDE, DO NOT SHIP** — measured, and the correct action is a ruling, not a code change.

**Nothing in this list is currently paging.** `v_rpc_trust_health` returned **zero rows with `status <> 'ok'`** at measurement time. This is debt and hardening, not an incident.

---

## Priority order (impact ÷ risk)

| # | Item | Class | Risk | Est. |
|---|---|---|---|---|
| 1 | git-history credential purge | OPERATOR-ONLY | Med (force-push) | 30 min |
| 2 | Arm 2 staged watchlist rows — **precondition is now met** | CLAUDE-CODE | Very low | 5 min |
| 3 | `db-pin-staleness.yml` repo secrets | OPERATOR-ONLY | None | 5 min |
| 4 | cron-job.org — 3 safe disables | OPERATOR-ONLY | Low | 10 min |
| 5 | Two public boards at 8.7 s / 10.9 s | CLAUDE-CODE | Med | 2–3 h |
| 6 | `ufc_fmv_pct_stale_30d` — 1.9 pp of headroom | DECIDE | Low | 15 min |
| 7 | `?specialSerials=true` returns an empty board (legacy path) | CLAUDE-CODE | Low | 30 min |
| 8 | `edge-deno` non-blocking, 16 `deno check` errors | CLAUDE-CODE (needs Deno) | Med | 3–4 h |
| 9 | Re-land the dead-code deletion | CLAUDE-CODE | Low | 1 h |
| 10 | 3,074 duplicate `players` rows | CLAUDE-CODE | Med-High | 3–4 h |
| 11 | Panini sale feed — re-check **from 2026-08-04** | DECIDE (timer) | None | 10 min |
| 12 | `ensure_players_from_edition_names` not cron-wired | DECIDE | Low | 20 min |
| 13 | UFC/Candy `set_id_onchain` unfillable | DECIDE | — | — |
| 14 | FMV overstatement — **do NOT retune the clamp** | DECIDE | — | — |
| 15 | Roadmap Phase 0–4 | Program | — | — |

---

## 1. git-history credential purge — **OPERATOR-ONLY**

**What's wrong.** `scripts/fetch-allday-collection.mjs` was sanitized at HEAD on 2026-08-01, but the secrets remain in git history on a **public** repo: live Dapper session cookies (`cf_clearance`, `nfl_session.0/1/2`) and an RS256 `ID_TOKEN` whose payload carries a real email address, a legal name, and a Flow account id. GitHub caches blob views, so deleting the file does not remove the reachable URL.

**Evidence (verified).** HEAD is clean — `scripts/fetch-allday-collection.mjs` now reads `process.env.ALLDAY_COOKIES` / `process.env.ALLDAY_ID_TOKEN` with a fail-fast guard (lines 22–27), and passes `ID_TOKEN` through as `x-id-token` (line 63). No hardcoded literal survives at HEAD. The 08-01 audit's repo-wide sweep found no sibling file with the same pattern. History was not touched.

**Fix.**
1. **Invalidate the Dapper session first** — log out / rotate on nflallday.com so the cookies are dead before the rewrite. This is the step that actually reduces risk; the rewrite only removes the artifact.
2. Rewrite history:
   ```
   git filter-repo --path scripts/fetch-allday-collection.mjs --invert-paths
   git push --force --all
   git push --force --tags
   ```
   Then re-add the sanitized HEAD version as a fresh commit.
3. Open a GitHub support request to expire cached blob/PR views for the affected SHAs.

**Risk.** Medium and social, not technical: a force-push rewrites every SHA on `main`. **Every ledger entry's `git revert <sha>` path in `docs/overnight/ledger.md` becomes invalid.** Coordinate — no concurrent session (including the 01:00 PT overnight pass) may be mid-push. Consider creating `docs/FREEZE.md` for the duration; both autonomous tasks drop to read-only while it exists, and delete it after.

**Revert path.** None, by design — a history rewrite is not revertible and should not be. Take a full mirror clone first (`git clone --mirror`) and keep it offline as the only rollback.

**Verification.** `git log --all --full-history -- scripts/fetch-allday-collection.mjs` returns nothing; the old blob URL 404s.

---

## 2. Arm the two staged watchlist rows — **CLAUDE-CODE-SHIPPABLE** — **the precondition is now met**

**What's wrong.** `audit_20260801_watchlist_pinnacle_sales_and_allday_pack_listings` inserted watchlist rows for `pinnacle-sales-indexer` and `allday-pack-listings` with `is_active = false` **deliberately** — `detect_stalled_pipelines()` fires on `last_run IS NULL`, so arming before the instrumentation deployed would have manufactured two false stalls. They are still inactive, so neither pipeline is monitored.

**Evidence (re-measured — the gate is CLEARED).**

| pipeline | `is_active` | `max_silent_minutes` | real `pipeline_runs` rows | last run | ok |
|---|---|---|---|---|---|
| `pinnacle-sales-indexer` | **false** | 90 | **4** | 2026-08-02 02:24 UTC | 4/4 |
| `allday-pack-listings` | **false** | 90 | **8** | 2026-08-02 02:30 UTC | 8/8 |

Both now have real, recent, all-`ok` runs. `last_run IS NULL` can no longer fire. **Arming is safe today.**

**Fix.** Apply via Supabase MCP (`apply_migration`), then record it in the ledger:
```sql
UPDATE public.pipeline_cadence_watchlist
   SET is_active = true
 WHERE pipeline IN ('pinnacle-sales-indexer','allday-pack-listings');
```

**Re-verify immediately after** (a 90-minute threshold against an indexer that ticks every ~30 min leaves little slack — if either goes amber straight away, widen `max_silent_minutes` rather than disarming):
```sql
SELECT * FROM detect_stalled_pipelines();
```

**Risk.** Very low. Worst case is a noisy `medium`-severity row, which cannot page (only `critical|high` page).

**Revert path.**
```sql
UPDATE public.pipeline_cadence_watchlist SET is_active = false
 WHERE pipeline IN ('pinnacle-sales-indexer','allday-pack-listings');
```

---

## 3. Repo secrets for `db-pin-staleness.yml` — **OPERATOR-ONLY**

**What's wrong.** The workflow soft-skips green until two repo secrets exist. It is the **only** check that can catch a DB pin whose live definition has drifted — the in-CI drift guard (`__tests__/db-invariants-drift-guard.test.ts`) compares the test's embedded DDL to the migration named in its `PINS` entry, which is **repo-vs-repo**. When a function is redefined via MCP with no committed migration, the pin, the test and the guard all stay green while the test validates a definition that no longer runs anywhere. Three of the then-42 pins were in exactly that state on 2026-07-31; there are **85 pins** now.

**Evidence (verified in-file).** `.github/workflows/db-pin-staleness.yml` lines 47–56:
```
if [ -z "${NEXT_PUBLIC_SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "::warning::… skipping the live pin-staleness check …"
  exit 0
fi
```
The header states the posture explicitly and notes the check **reads only `pg_proc` and mutates nothing**.

**Fix.** GitHub → repo → Settings → Secrets and variables → Actions → New repository secret, twice:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Then run the workflow manually (`workflow_dispatch`) once and read the output. The script exits 1 on a stale pin, 2 on a config/query error.

**Risk.** None to production — read-only. The only consequence is that a previously-invisible red becomes visible, which is the point.

**Revert path.** Delete the two secrets; the workflow returns to soft-skip.

**Note.** Until this lands, a Claude Code session can replicate it manually via MCP with no service-role key — pull each pinned function's `prosrc`, md5 it in SQL under both `collapse` and `collapse(stripComments)` normalizations (matching `scripts/check-db-pin-staleness.mjs`), and compare against the committed migration bodies. That was done on 2026-08-01 over all 84 pins then existing: **0 stale, 0 not-deployed.** It is manual and does not repeat itself, which is why the workflow matters.

---

## 4. cron-job.org — three safe disables — **OPERATOR-ONLY**

### Why an agent must not drive this console

**Opening a job-EDIT page renders the Authorization header value in the DOM — including on the Advanced tab when that tab is not visibly open.** A prior Cowork session leaked `INGEST_SECRET_TOKEN` by broad-reading such a page (`read_page` / `querySelectorAll`). Any agent-driven browsing of cron-job.org risks re-leaking a live secret into a transcript. **These three changes are three clicks each. Do them by hand.**

### The three entries

A full 85-job inventory was taken 2026-08-01 (78 enabled / 7 disabled, zero orphans, zero apex-domain URLs — the apex 308-redirect trap is clean).

**a. `RPC EVM Transfers Ingest` — disable.** Re-measured live: `evm_nft_transfers` holds **0 rows**; the pipeline has **74 runs inside the ~73 h `pipeline_runs` retention window, with `sum(rows_found) = 0` and `sum(rows_written) = 0`**, still firing (last run 2026-08-02 02:19 UTC). Beezie/Base is retired. It is **not in `vercel.json`**, so cron-job.org (or pg_cron) is the sole driver. ⚠ Note: CLAUDE.md still describes "1.01M Beezie transfers" — **that table is now empty**; update that line when convenient.

**b. `RPC V1-Dapper Recovery` — disable.** `vercel.json` line 9 already schedules `/api/admin/recover-v1-budget-exhausted` at `*/20 * * * *`, and that copy does the work. The cron-job.org duplicate times out at the console's 30 s cap on every run, producing a permanent false red. (`allday-price-recover` shows 249 runs / 73 h against the ~219 that `*/20` alone implies — consistent with a second scheduler, though the DB cannot attribute a run to a scheduler; the console is the arbiter.)

**c. `RPC Pinnacle Sync` — ~~disable~~ 🛑 **DO NOT DISABLE. This instruction is WRONG and would take the pipeline fully dark.** (Corrected 2026-08-02 17:13 UTC, Claude Code.)

The original reasoning — "`vercel.json` line 25 schedules it at `0 6 * * *`; measured 3 runs in 73 h = exactly 1/day, matching the Vercel schedule alone" — checked the **cadence** and never checked the **clock**. Every observed run is at **10:07Z**, not 06:00Z:

| started_at | ok | rows_written |
|---|---|---|
| 2026-08-01 10:07:13Z | true | 2,164 |
| 2026-07-31 10:07:12Z | true | 2,172 |

`0 6 * * *` has produced **zero** `pipeline_runs` rows in the entire retained window. The 1/day cadence is being delivered by the **cron-job.org entry**, so disabling it removes the only driver that demonstrably works and leaves a Vercel schedule with no evidence it fires at all. Pinnacle sync writes ~2,170 rows/run.

⚠ This is exactly the trap CLAUDE.md already documents for the GHA→Vercel cron move: **verify a tick whose MINUTE matches the new schedule — a matching daily count proves nothing about which scheduler produced it.**

**Also note — and do NOT misread this as a second dropout:** `detect_stalled_pipelines()` reports `pinnacle-sync` silent ~31 h against its 1,560-min threshold, but **the pipeline ran normally today**. `pinnacle_fmv_history` holds **1,936 rows written at 2026-08-02 10:07:13.742Z**, on its usual schedule. It executed and wrote **no `pipeline_runs` row** — an **observability gap**, so the stall row is a false alarm and the cron-job.org entry is still delivering. (An earlier draft of this correction called it a dropout; that was wrong, and a concurrent Cowork session had already diagnosed it correctly.)

**The correct operator action for (c) is the opposite of the original: leave the cron-job.org `RPC Pinnacle Sync` entry ENABLED, and investigate why the Vercel `0 6 * * *` copy logs nothing** (most likely it never authenticated — `/api/cron/pinnacle-sync` must accept `CRON_SECRET`, the only header Vercel Cron can send). Only after the Vercel copy is *observed* ticking `ok=true` at 06:00Z is it safe to disable the cron-job.org one. Separately worth fixing: the run at 10:07Z should be writing a `pipeline_runs` row and isn't.

**Risk.** (a) and (b) are low — verified independently below. **(c) as originally written was HIGH: a silent, complete stop of Pinnacle sync.**

**Re-verification of (a) and (b) — both CONFIRMED safe (2026-08-02 17:13 UTC):**
- **(a)** `evm_nft_transfers` = **0 rows**; `evm-transfers-ingest` = **75 runs, 75 ok, `sum(rows_found)=0`, `sum(rows_written)=0`**, last 15:19Z. Genuinely inert. Safe to disable.
- **(b)** `allday-price-recover` fires at minutes **0, 20, 40** (the Vercel `*/20`) **plus 1 and 43** — 258 runs over 76.3 h against the ~229 that `*/20` alone implies. A second driver is confirmed and the Vercel copy is proven working. Safe to disable the duplicate.

**Revert path.** Re-enable the job in the console (the entry is disabled, not deleted). For (a), if Beezie/Base is ever revived, the promotion path is documented in CLAUDE.md (`ALTER TYPE chain_type ADD VALUE 'base'`).

---

## 5. Two public boards are one contention spike from rendering empty — **CLAUDE-CODE-SHIPPABLE**

**What's wrong.** Two board views run for many seconds against a 30 s `service_role` statement budget on an IOPS-bound Micro instance. This is the **exact** failure that hit `candy_holder_board` on 2026-08-01: an 82 s view blew the request budget, the page's fail-soft `fetchView` returned `[]`, and a headline tab on a **live public board** read "Holders 0" against 373 real collectors — **with nothing in Sentry.** A fail-soft read path converts a slow query into a silent lie.

**Evidence — measured live with `EXPLAIN (ANALYZE, BUFFERS)` just now:**

| view | Execution Time | rows | buffers |
|---|---|---|---|
| `topshot_perfect_mint_premiums_board` | **10,882 ms** | 178 | 669,133 hit + 42,665 read |
| `topshot_pack_reality_dist` | **8,749 ms** | 6 | 74,406 hit + 19,118 read, **temp read 1,362 / written 227** |

⚠ **The source handoff's proposed fix is wrong for both of these.** It said "scope the FMV lookup to the collection partition slice instead of joining global `fmv_current`". **Neither view references `fmv_current` or `fmv_snapshots` at all** — verified against `pg_views.definition`. That fix shape was correct for `candy_holder_board` and does not transfer. The real hot spots are:

- **`topshot_perfect_mint_premiums_board`** — two independent scans of `sales`. The `ed_med` CTE runs `percentile_cont` over **432,443 rows** of the 180-day Top Shot window (454,488 buffers) and the `perfect` CTE scans the 90-day window (211,793 buffers) before a merge join. Output is 178 rows.
- **`topshot_pack_reality_dist`** — a `rips` CTE scanning **113,427** `pack_rips` rows, then **CTE-scanned seven times** (once per UNION arm plus the `total` initplan), spilling to temp each pass. Output is 6 rows.

**Fix — the precedent already shipped today.** `audit_20260801_market_index_daily_materialize` took `topshot_market_index_daily` from **5,809 ms → 0.459 ms** by materializing it behind an hourly `REFRESH MATERIALIZED VIEW CONCURRENTLY` pg_cron job, **keeping the view's name, column list, `security_invoker=on` and grants** so no consumer changed. Do the same here:

- `mv_topshot_perfect_mint_premiums_board` + unique index on `edition_id`, refreshed CONCURRENTLY hourly.
- `mv_topshot_pack_reality_dist` + unique index on the ordinal/bucket key, refreshed CONCURRENTLY hourly.
- Rewrite each `public.<name>` view to `SELECT * FROM mv_<name>`, re-asserting `security_invoker` and grants (`CREATE OR REPLACE VIEW` **wipes `reloptions`** — re-set them in the same migration).

⚠ **An MV is not the view it mirrors.** Do not let any consumer read the MV directly; keep the view as the published name so a future predicate change lands in one place.

For `topshot_pack_reality_dist` a cheaper alternative exists if you prefer not to add an MV: aggregate the `rips` CTE **once** into a single row of counters and derive all six output rows from it, eliminating the seven-pass CTE scan. Measure before choosing — the MV is the safer, already-proven shape.

**Files/objects.** `pg_views` definitions for both boards; new migration `audit_20260802_*`; two pg_cron entries (use the `cron_heavy` role — `statement_timeout` is 600 s there, and `GRANT EXECUTE` must precede scheduling). Public consumers: the `/insights` boards and `app/api/public/insights/*`.

**Risk.** Medium. An MV introduces staleness (bounded to 1 h, acceptable for both — one is a 180-day median board, the other a 60-day distribution) and a refresh job that consumes DB time on a constrained instance. Verify the refresh cost before scheduling.

**Revert path.** Per migration comment: `SELECT cron.unschedule('<job>');` then re-`CREATE OR REPLACE VIEW` with the original definition (quote it verbatim in the migration header), then `DROP MATERIALIZED VIEW IF EXISTS mv_<name>;`

**Verification.** Row counts identical pre/post (178 and 6); `EXPLAIN ANALYZE` under 100 ms; the rendered board shows the same content (**rendered DOM, not HTTP 200**); `check_public_security_invariants()` returns 0.

---

## 6. `ufc_fmv_pct_stale_30d` has 1.9 pp of headroom — **DECIDE**

**What's wrong.** The metric was raised 90 → 101 as the value climbed, making it **mathematically unbreachable** (a percentage cannot exceed 100). The 08-01 audit lowered it to 98. It will now flip on ordinary drift, and the underlying condition is not a defect.

**Evidence (re-measured).** `ufc_fmv_pct_stale_30d` = **96.1**, `breach_at` = **98**, status `ok`. Companion `ufc_fmv_stale_hours` = 9.5 against `breach_at` 30, also ok. The whole trust board has **zero** non-`ok` rows.

**Context.** UFC-on-Flow trading is closed **today**, but ⚠ **two claims this doc originally made were wrong, both corrected 2026-08-02 by Trevor.**

1. **Causation.** Not "the Aptos migration on 2026-05-13." Two separate closures: UFC Strike's own **studio/native** marketplace feed ends **2025-08-07** (813,380 sales back to 2022-02-15), and the residual **Flowty** secondary venue ended **2026-05-13** with the Flowty frontend shutdown. The Aptos migration is a separate fact.
2. **Coverage — the more important one.** The apparent 8-month gap between those feeds is **an ingest-window artifact, not a dead market.** `sales.source` breaks down as `ufc_studio_history_v1` 813,380 (2022-02-15→2025-08-07), `onchain` 53 (2026-04-18→2026-05-13), `flowty_archive_extractor` 2 (2026-04-11). RPC's UFC history is almost entirely UFC's **own studio platform**, and on-chain UFC indexing did not begin until ~2026-04-11 — so **nothing observed the interval between them.** Flowty's UFC secondary market was active for **years** and is essentially absent from `sales`. `flowty_transactions` cannot fill it (that scanner only ran 2026-04-25→2026-05-24 for *every* collection; UFC: 8 rows), and `ufc-sales-history-backfill` is parked at the spork retention floor 137390146 where V1 history is pruned from public Flow REST (404) — so the pre-floor portion is very likely **unrecoverable**.

⚠ **Treat UFC secondary volume, and any UFC FMV derived from it, as a FLOOR — not a census.** The conclusions below (dead market, don't chase coverage, label the values) are unchanged. 96.1% of priced UFC editions having a >30-day-old latest FMV is the honest state of a dead market, not a pipeline failure. UFC also holds **0 of 518 editions with `set_id_onchain`** and **0 with `game_date`** — see item 13.

**Three honest options, pick one:**

1. **Accept the page.** When it fires, the alert says "UFC is dead", which the team already knows. Cost: one recurring false-positive-shaped alert forever.
2. **Widen with a written justification** (e.g. `breach_at = 99.5`) and put the reason in the metric's `catches` text so the next auditor does not re-raise it. This preserves a genuine tripwire for "UFC came back and then stalled".
3. **Retire the metric** and record UFC as intentionally frozen. Cleanest, but loses the signal if UFC ever revives on Flow.

**Recommendation: option 2.** It keeps a real tripwire while acknowledging the market state, and it is one `UPDATE`. Do not silently re-raise above 100 — that is what produced the unbreachable threshold in the first place.

**Revert path.** `UPDATE <trust-health config table> SET breach_at = 98 WHERE metric = 'ufc_fmv_pct_stale_30d';` (read the current row first; the config lives behind `v_rpc_trust_health`).

---

## 7. `?specialSerials=true` can only return an empty board on the legacy path — **CLAUDE-CODE-SHIPPABLE**

**What's wrong.** On the legacy `cached_listings` path, `collapseToEditions()` unconditionally emits `isSpecialSerial: false` for every collapsed row, and the `specialSerials` predicate runs **after** the collapse. A #1 serial in the source data is filtered out along with everything else.

**Evidence (verified in-file, `app/api/market/route.ts`).**
- Line 99 `function collapseToEditions(rows)`; line 128–129 emit `serialNumber: null, isSpecialSerial: false`.
- Line 804 `let postFiltered = collapseToEditions(enriched)`.
- Lines 816–818 `if (specialSerials) { postFiltered = postFiltered.filter(r => r.isSpecialSerial) }` — always zero.
- Pinned by `__tests__/api-market-total-honesty.test.ts` line 158, `it("FINDING: ?specialSerials=true on the legacy path can only ever return an EMPTY board", …)`.

⚠ **Scope correction.** This is **only** the legacy path. The **modern aggregated path is fine** — line 629 applies the same filter to per-row `isSpecialSerial` values computed at line 608, with no collapse in between. The legacy path serves **Golazos and UFC only** (see the function's own comment, lines 92–98: "TS/AllDay/Pinnacle aggregate at their source"). So the blast radius is two low-volume collections, and the board is honestly empty rather than wrong.

**No UI references the param** — grepped across `app/` and `components/`; the only other `specialSerials` occurrences are the unrelated moment-page variable in `app/moment/[id]/page.tsx`.

**Fix — pick one, do not do both:**

- **(a) Remove the param.** This matches the precedent the sniper feed already set (`fa1d356` dropped the unsatisfiable per-serial predicate rather than let a control silently no-op). Delete lines 816–818 and the `specialSerials` read at line 483 *only if* line 629's use is also removed — **it is not broken, so prefer keeping line 629 and removing only the legacy-path block**, or return a `400` on the legacy path explaining that Market is edition-grain. Update the `FINDING:` test to assert the new behaviour.
- **(b) Implement at serial grain.** Have `collapseToEditions` carry `isSpecialSerial: g.some(r => r.isSpecialSerial)` (edition contains a special serial) and re-word the filter as "editions containing a #1 or last serial". This is a **semantic change** — it answers a different question than the param name implies — so it needs a product call, not a silent fix.

**Recommendation: (a), scoped to the legacy path.** Market is edition-grain by design (Trevor, 2026-07-18); serial-grain filtering belongs on Sniper.

**Risk.** Low. No UI consumer; the test already pins current behaviour, so any change reds it deliberately.

**Revert path.** `git revert <sha>` (one route block + one test assertion).

---

## 8. `edge-deno` is non-blocking with 16 `deno check` errors — **CLAUDE-CODE-SHIPPABLE (needs a Deno toolchain + deploy session)**

**What's wrong.** `edge-deno` is the only thing type-checking `supabase/functions/**` (vitest and `tsc` both exclude it). It carries `continue-on-error: true`, so a real edge-source type error lands silently. This was not hypothetical: `deno check` caught a **live prod bug** on 2026-07-31 — `scan-pinnacle-wallet` had been writing nothing to `wallet_moments_cache` since June 10 because a "fix" commit deleted the `.from(...)` line.

**Evidence (verified in `.github/workflows/ci.yml`).** Line 288 `continue-on-error: true`. The header comment (lines 307–320) records the 2026-07-31 root cause precisely:

> 16 errors remain, ALL from a genuine toolchain conflict, NOT edge-source bugs:
> `--node-modules-dir=auto` is REQUIRED — the SDK's `edge-runtime.d.ts` pulls a transitive `npm:openai` type dep that only resolves in node_modules mode. BUT node_modules mode rejects the SDK's jsr-**subpath** import (`@supabase/functions-js/edge-runtime.d.ts`, ×12) and the deno.land-**URL** import (`std/http/server.ts`, ×2) as "not a dependency". Plus 2 `TS7022` cascades.

**Fix — the in-repo instruction (ci.yml lines 317–320), which is more specific than the CLAUDE.md phrasing:**
1. Map `@supabase/functions-js/edge-runtime.d.ts` to a `npm:` specifier in `supabase/functions/deno.json` (type-only, deploy-safe).
2. Replace the 2 `std/http/server.ts` `serve` imports with `Deno.serve`.
3. Re-run `deno check`; the 2 `TS7022` cascades should clear with them.
4. Only then drop `continue-on-error: true` — the same promotion path `cadence-lint`, `cadence-escrow-tests` and `db-tests` each followed.

**Prerequisites this sandbox lacks.** A Deno toolchain (install from the **GitHub release**, not deno.land — that host is proxy-blocked) and network reach to jsr.io / esm.sh. A cloud sandbox is 403'd on both, so **CI is the only adjudicator**. Full playbook: [docs/handoff-2026-07-30-deno-edge-ci.md](docs/handoff-2026-07-30-deno-edge-ci.md).

⚠ **The repo source DIVERGES from the deployed edge functions.** The 2026-07-30 bare-specifier refactor rewrote 36 functions' import lines and nothing was redeployed. The next `supabase functions deploy <fn>` ships the bare-specifier version resolved via `deno.json`. **Deploy one low-risk function first and verify via its next cron `pipeline_runs` tick (`ok:true`), not a manual curl** — the auto-mode classifier blocks outbound gated calls.

**Risk.** Medium. Promoting blind reds `main` for every concurrent session. Do not flip `continue-on-error` until a CI run is observed green.

**Revert path.** `git revert <sha>` restores the import lines; re-add `continue-on-error: true` to un-promote.

---

## 9. Re-land the dead-code deletion — **CLAUDE-CODE-SHIPPABLE**

**What's wrong.** 16 zero-importer modules + 13 associated tests were deleted (`fc68e05`) and then **reverted** because the component-coverage ratchet dipped below its threshold. The modules are still genuinely zero-importer, so the repo carries them for nothing.

⚠ **I could not verify the module list** — this session is read-only on git by instruction, and `fc68e05` is not referenced anywhere in `docs/`. **Re-derive it first:**
```
git show --stat fc68e05
```
Then re-confirm zero-importer status per file with a grep that covers **both** the `@/` alias and relative paths, across `.ts/.tsx/.mjs/.js`, including `vi.mock()` strings in `__tests__/`.

⚠ **Check this against CLAUDE.md before deleting.** CLAUDE.md explicitly records that several zero-prod-importer `lib/` modules are **deliberately retained** (Cart Cadence, `blazers-trivia`, `logger`, `pro-gates`) and that "deleting them is wrong". If any of the 16 overlaps that set, drop it from the batch and say so in the ledger entry.

**Fix.** Re-land bundled with coverage-positive work, or after a measured re-baseline of the component gate. Current thresholds, verified in `vitest.components.config.ts` lines 459–462: **statements 74.6 / branches 61.75 / functions 73.5 / lines 78.65**.

**NEVER lower the threshold to make the deletion pass.** The correct sequence is: measure actual coverage after deletion → if it dips, add coverage in the same commit until it clears → only then push.

⚠ **Sandbox constraint that caused the original failure loop.** A full coverage run and a full `npx tsc --noEmit` **each exceed the Cowork sandbox's 45 s per-command cap** (exit 124), and backgrounded jobs are reaped because every bash call gets its own PID namespace. The technique that worked on 2026-08-01 is **sharded coverage runs merged by hit-count union**. On Trevor's Windows box there is no such cap — run it normally.

**Risk.** Low, once the zero-importer status is re-verified per file.

**Revert path.** `git revert <sha>`.

---

## 10. 3,074 duplicate `players` rows — **CLAUDE-CODE-SHIPPABLE**

**What's wrong.** Top Shot `players` holds many rows per real player, forcing `get_player_detail` to *choose* which row's `team` the public page shows. The visible symptom (219 pages showing a wrong current team) was largely fixed on 2026-08-01 by `418ed607`, which added a **data-relative activity horizon** (`collection max(game_date) − 18 months`) so a traded-but-active player resolves to their current team while a retired player keeps their iconic one. **The duplicates themselves remain**, so the correctness depends on a tie-break rather than on the data being right.

**Evidence (re-measured live, Top Shot `players`).**

| measure | value |
|---|---|
| distinct name-slugs | **1,359** |
| slugs with >1 row | **948** |
| rows inside duplicate slugs | 4,022 |
| **surplus rows** | **3,074** |
| max rows for one slug | **32** |
| slugs whose rows disagree on `team` | **352** (of 1,326 with any team) |
| max distinct teams for one slug | **6** |

(The source handoff said 949 / 3,075 — off by one, consistent with churn since.)

**Related, and not previously listed:** **9,731 of 19,581 Top Shot editions (49.7%) have `player_id IS NULL`**, versus 0.6% on AllDay and 0% on Golazos/Candy. Both `get_player_detail` and `get_player_editions` reference *both* `player_id` and `player_name`, so I have **not** proven a user-visible defect from this — but a dedupe that repoints `editions.player_id` should fix the FK coverage in the same pass. Measure the rendered effect before claiming one.

**Fix (durable).** A dedupe migration: for each `(collection_id, slug)` group keep the row with the most editions, repoint `editions.player_id` to the survivor, then delete the surplus.

**Before writing any DELETE:**
1. **Re-measure** — these counts move.
2. **Enumerate every FK to `players.id`** (the 08-01 phantom-editions item swept all 51 FKs on `editions` and found two that mattered; do the equivalent here).
3. **Check `pg_proc` bodies, not just a code grep** — the 07-31 ownership-scanner deep dive found the naive retirement SQL would have left a broken dormant DB function. Grep `prosrc` for `players` before dropping rows.
4. Note the upstream key is legitimately `UNIQUE(external_id, collection_id)`, so duplicates are **expected** from the ingest side. A dedupe must not fight the ingest — either it runs periodically, or the ingest gains a canonical-player concept.

**Risk.** Medium-High. `players` is joined by team pages, player pages, challenges, and the concierge. **This gates the collection-agnostic Team Hub** (roadmap Phase 3) — do not build team identity on top of it unfixed.

**Revert path.** Capture the full pre-state of every deleted row and every repointed `editions.player_id` as runnable `INSERT`/`UPDATE` statements in the migration's comment header (the pattern `audit_20260801_remove_nfl_phantom_editions_filed_under_topshot` used). There is no other way back.

**Verification.** `get_player_detail` still resolves for all 5 published collections (including Pinnacle's `character_name` branch and UFC's honest null team); the 08-01 traded-active / retired assertions in `supabase/tests/get_player_detail.sql` still pass; drift guard green; spot-check rendered player pages.

---

## 11. Panini sale feed — re-check **from 2026-08-04** — **DECIDE (timer)**

**What's wrong.** Upstream stopped supplying Panini serial sale prices. `panini_sale_feed_status.feed_ok = false`.

**Evidence (re-measured).** `last_supplied_on` **2026-07-28**, `days_since_last_supplied` **5**, `pct_serials_priced` **7.66%** (3,925 priced of 51,229 serials, 126 preserved fossils). The disclosure gate on this item is **>7 days**, i.e. **2026-08-04**.

**Why it was correctly NOT shipped on 08-01, still true today.** Panini FMV itself is **fresh** — latest `panini_fmv_snapshots.computed_at` is **74 minutes old**, with **1,226 rows written in the last 24 h** (the Windows-box runner is healthy). And the stale field (`serials_with_recorded_price`) is fetched into the client Row type but is **not one of the 10 rendered columns**. So **no user-visible number on the public board is stale.**

**Fix, if still out on 2026-08-04.** Add **one line to the EXISTING listing-gated coverage banner** on `/insights/panini-squeeze`. **Do not add a second banner** — a second warning dilutes the mandatory listing-gated coverage disclosure sitting beside it, and that disclosure is a launch requirement that travels with the surface. The JSON already carries the data at `meta.sale_price_feed` in `/api/public/insights/panini-squeeze`, fail-soft in the same shape as `meta.coverage`.

**Re-check earlier than 08-04 if** `panini_fmv_snapshots` stops advancing — that would make a rendered number stale and changes the calculus immediately.

**Revert path.** `git revert <sha>` (one copy line).

---

## 12. `ensure_players_from_edition_names` is not cron-wired — **DECIDE (downgraded on measurement)**

**What's wrong.** The function seeded 70 missing player pages on 2026-08-01 and is re-runnable, but nothing schedules it, so coverage drifts as new editions land.

**Evidence (re-measured — the urgency is much lower than stated).**
- `public.ensure_players_from_edition_names(p_collection_id uuid, p_limit integer)` exists; **0 `cron.job` rows reference it.** Confirmed.
- **Actual current drift: 2 names.** Counting distinct `(collection_id, trim(player_name))` pairs on `editions` with no case-insensitively matching `players` row: **UFC 2, everything else 0.** Not 70, not hundreds — **two**.

**So the correct read is: the backlog is drained and drift is currently negligible.** Scheduling this is a DB-time decision, and CLAUDE.md is explicit that **the DB is the binding constraint at WAU 0** and pipelines already consume nearly all of it.

**Recommendation.** Do **not** add another pg_cron job for a 2-row drift. Either:
- fold the call into an existing edition-ingest path so it self-heals at write time (zero new schedule), or
- leave it manual and re-measure with the query above during a periodic sweep.

If it is ever scheduled, use `cron_heavy` and a low frequency (daily at most).

**Revert path.** `SELECT cron.unschedule('<job>');` if one is added.

---

## 13. UFC and Candy `sets.set_id_onchain` are unfillable — **DECIDE (no action available)**

**What's wrong.** `sets.set_id_onchain` is NULL for **all 256 UFC sets** and the **1 Candy set**. There is nothing to bridge from: `editions.set_id_onchain` is itself **0 of 518 for UFC** and **0 of 125 for Candy**.

**Evidence (re-measured).**

| collection | `sets` rows | NULL `set_id_onchain` | `editions` | editions with `set_id_onchain` |
|---|---|---|---|---|
| ufc_strike | 256 | **256** | 518 | **0** |
| candy_mlb | 1 | **1** | 125 | **0** |
| nfl_all_day | 363 | **0** | 6,190 | 6,190 |
| laliga_golazos | 23 | 0 | 575 | 575 |
| nba_top_shot | 266 | **12** | 19,581 | 13,021 |

AllDay's 363 were bridged on 2026-08-01 and are confirmed complete. **Not previously reported: Top Shot still has 12 NULL `sets.set_id_onchain` rows** — small, and TS *does* have a bridge source (13,021 editions carry the value), so those 12 are plausibly fixable by the same self-heal path `ensure_topshot_edition_stub` already uses. That is the only actionable slice here.

**Fix.** Closing UFC/Candy requires a **new ingest lane** that reads the on-chain set id, not a data fix. For UFC that is work against a **dead market** (native Flow marketplace ended ~2025-08-07; the residual Flowty secondary venue ended 2026-05-13 — see §6, corrected 2026-08-02) — per the roadmap's explicit "do not chase coverage on a dead market" ruling, **do not build it.** For Candy it would ride along with any future Candy ingest expansion.

**Recommendation.** Record UFC and Candy as structurally unfillable and stop re-flagging them in audits. Optionally sweep the 12 Top Shot NULLs.

**Revert path.** N/A (no change proposed).

---

## 14. FMV overstatement on liquid Top Shot editions — **DECIDE: do NOT retune the clamp**

**What's wrong (as originally framed).** ~409 of ~4,443 liquid Top Shot editions (≥4 sales/30 d) carry an FMV more than 2× their own sales median, concentrated in the ask-blended LOW confidence tier.

**Evidence — independently reproduced just now, and the dollars kill the headline.**

| measure | value |
|---|---|
| liquid Top Shot editions (≥4 sales/30 d, with FMV) | **4,377** |
| of those, FMV > 2× own 30 d sales median | **426 (9.7%)** |
| median sale price *within that cohort* | **$0.30** |
| **total overstatement across all 426** | **$291** |
| cohort editions with FMV ≥ $20 | **0** |

The 08-01 session measured the same cohort at 432/4,412 with $339 total and a $0.55 median overstatement, 4 editions above $5 FMV and **zero above $20**. Two independent measurements agree: **this is a ratio artifact on penny moments.** A common moment whose median sale is $0.30 and whose FMV reads $1.00 is "3.3× overstated" and wrong by seventy cents.

**Ruling: do NOT move `fmv_clamp_disconnected_ask_topshot` from 3× to 2×.** It would touch ~426 editions to recover ~$291 while adding real risk of suppressing genuinely-rising editions mid-run-up — a strictly bad trade.

**If this is ever revisited, gate on ABSOLUTE gap (e.g. > $25), not ratio.** Ratio-only screens on sub-dollar denominators will keep manufacturing this false alarm.

**This is FMV pricing logic. Propose, do not autonomously retune** (standing rule: data fixes OK; pricing logic → hand off).

**Revert path.** N/A (no change proposed). If a future session ships an absolute-gap clamp, the revert is re-applying the prior `CREATE OR REPLACE FUNCTION` body, and the pin must be re-pointed **and its assertions re-read** — the 07-31 audit found a clamp test asserting a circulation gate production had already stopped exhibiting.

---

## 15. Roadmap Phase 0–4 — summary only

Full detail: **[docs/strategy/roadmap-2026-08-01.md](docs/strategy/roadmap-2026-08-01.md)**. Do not re-derive it here. The headline framing that governs everything below: **WAU is 0, signups in the last 45 days are 0, and Phase 0 is worth more than Phases 1–4 combined until it produces a number above zero.** Do not answer WAU=0 with more features.

- **Phase 1 — the dual-scale valuation promise.** "What is my collection worth" answered at two scales: everything-everywhere across collections and chains, and inside one collection across **both items and packs**. The packs half is the differentiated part and the part most likely to be quietly wrong; coverage disclosure is a Phase-1 requirement, not polish. The deliverable is the promoted `/insights/account-value` returning a rollup with an explicit **"Not priced:"** line.
- **Phase 2 — feature parity + IA restructure.** Six sections per collection (My Wallet / Market / Sniper / Play / Sets / Analytics) with **Overview folded into Analytics and deleted**. Parity means "every section a collection's data can support is present and consistent", **not** "every collection has six tabs" — Play is Top-Shot-only and will stay so. Includes deploying the `scan-pinnacle-wallet` fix (committed 2026-07-31, still **not deployed**; note Pinnacle `wallet_moments_cache` is being written by another path — 50,967 rows across 138 wallets, last insert 2026-08-01 21:39 UTC — so this is lower urgency than the prior handoff implied, but the edge fn is still broken).
- **Phase 3 — the Hobby axis.** DB groundwork **shipped 2026-08-01**: `hobby_type` enum, `collections.hobby`, and the `collection_hobbies` view, all 7 collections seeded. **Nothing reads it yet.** The roadmap's recommendation is **Option C** (an aggregate-only `/hobby/<name>` destination page) now, Option A (full route prefix) once a hobby has ≥2 real collections, **never Option B** (a query-param filter — buys nothing on discovery). Also here: the collection-agnostic Team Hub, which is **gated on item 10** and on building a canonical team registry (three non-interchangeable team-slug vocabularies exist today).
- **Phase 4 — read-only conversion + identity.** Delete (not gate) Cart, Trade Hub and Gifting; make "zero `fcl.mutate` call sites" a test. Replace the **polymorphic, client-controlled `owner_key`** — measured live to hold an auth UUID, a `profile_bio.username`, *and* a `0x` address, with no server-side mapping table — with a real `user_wallets (user_id, chain, wallet_kind, address, …)` table whose PK structurally enforces one wallet per chain and three for Flow, and whose writes resolve `user_id` from the **session**, never a request body. That single rule permanently kills the IDOR class that produced 5 route fixes on 2026-08-01.

---

## Already done today — do NOT redo

Everything below shipped on 2026-08-01 and is verified live. A future session that re-derives any of it is burning time.

**Security**
1. `scripts/fetch-allday-collection.mjs` sanitized to the env-var pattern (HEAD only — history is item 1).
2. `moment_acquisitions` (790,801 rows / 89,117 with buy prices / 7,627 wallets) revoked from `anon` **and** `authenticated`.
3. Five IDOR routes closed (`profile/watchlist`, `watchlist`, `wallet/save`, `wallet/profile`, `profile/portfolio-history`) behind new `lib/auth/owner-key-guard.ts`.
4. `watchlist_items` revoked; 6 dead `qual=true` policies on `panini_*`/`candy_offers` dropped.
5. Six anon-EXECUTE volatile writers revoked **FROM PUBLIC** as well as by role.

**Data correctness**
6. 2,781 pack pages un-hidden (`pack_ev_latest` now admits unknown-price packs with all price-relative fields forced NULL). Platform total 1,814 → 4,595.
7. 489 Top Shot packs regained Typical Pull.
8. Candy Holders tab fixed (82.3 s → 2.9 s; 373 collectors, was rendering 0).
9. 91 Golazos moment pages' 404 team links fixed; Golazos accented team pages now redirect to canonical.
10. 2 NFL phantom editions + 2 phantom sets removed from under Top Shot.
11. Fabricated `$0.00` realized pull value killed on 534 Top Shot pack pages.
12. A $5,000,000 troll ask flagged on the public squeeze board.
13. UFC sniper/market tier chips fixed (515 of 518 editions were unfilterable); `lib/collection-tiers.ts` is now the single source.
14. `/insights/market` and `/api/market-analytics` un-500'd (`mv_topshot_market_index_daily`, 5,809 ms → 0.459 ms; a covering index, 36,240 ms → 814 ms).
15. NaN crash class fixed on 16 public `/insights` routes (`?limit=abc` → 500).
16. `get_player_detail` current-team tie-break fixed (`418ed607`); net **faster** (45 ms → 19.5 ms).

**Ops / monitoring**
17. `v_pipeline_failure_rates` + a new `get_pipeline_alerts()` arm — the "running ≠ working" gap.
18. `topshot-listing-cache` + `allow-list-reconcile` moved GHA → Vercel cron (both routes widened to accept `CRON_SECRET`).
19. `topshot-active-listings-ingest` egress-block short-circuit (24.2 min → ~1 min per blocked run).
20. `ufc-backfill` retuned 72×/day → daily; `compute-laliga-pack-ev` + `purge-stale-listings` instrumented.

**Public surface**
21. Ask-derived FMV disclosed on 4 surfaces (5,794 Flow + 727 Panini editions priced at 0.9× a single ask).
22. AI crawlers unblocked in `app/robots.ts`.
23. Homepage `<h1>` → "What is your collection worth?"; `/insights/account-value` promoted from card #24 to #1.

**Tests / DB pins**
24. DB-invariant pins 66 → **85**; component gate now 74.6/61.75/73.5/78.65.

### Closed by this doc's measurements — the ledger's open follow-up is RESOLVED

The 2026-08-01 ledger left an explicit ⚠ follow-up: *"confirm the two new Vercel crons actually authenticate — if runs go to ZERO, `CRON_SECRET` is unset and you must revert."*

**They authenticate. Verified.** Hourly `pipeline_runs` counts since the cutover:

| hour (UTC) | `topshot-listing-cache` | `allow-list-reconcile` |
|---|---|---|
| 08-01 22:00 | 2 | 1 |
| 08-01 23:00 | **3** | 1 |
| 08-02 00:00 | **3** | 1 |
| 08-02 01:00 | **3** | 1 |

3/hour is exactly the designed `15,35,55` cadence (72/day), against the 10–13/day GitHub Actions was delivering. `allow-list-reconcile` is at its designed 1/hour. **Do not revert `2fefdad9`.**

---

## Premises that did NOT survive verification

**On 2026-08-01, four separate audit claims were disproved on contact, and this session disproved four more.** Every one of them would have caused wasted or actively harmful work. **Re-verify a handoff's premise before acting on it — that is where half the value of these sessions has come from.**

### Disproved on 2026-08-01

1. **`special_serial_holders` is live, not dead.** It was proposed for retirement. The live special-serial path runs through `special-serial-sweep` → `getMintedMoment`/`wmc` → `special_serial_holders`. Retiring it would have broken a working feature.
2. **The component-coverage dip was one stale test, not a coverage regression.** The hypothesis that deleting dead code had structurally lowered coverage was wrong.
3. **The Market Overview backing routes DO exist.** They were claimed missing.
4. **"441 wallet-box views → 0 pastes" is a traffic reading, not a conversion one.** The forked wallet inputs emitted **no `wallet_paste` at all** until `f7b665ea` (2026-07-26), so all pre-07-26 zeros measured blindness. Since then: 235 view events but only **7 with a referrer**; **175 of 183 sessions fired exactly one event**. The plausibly-human denominator is **~8**, not 441 — and the single recorded paste is Trevor's own wallet in a 36-event self-test session. **Do not redesign the wallet box on this evidence.** The input is traffic (roadmap Phase 0).

### Disproved by this session

5. **Item 5's fix shape was wrong.** The two slow boards were said to need "the FMV lookup scoped to the collection partition slice instead of joining global `fmv_current`". **Neither `topshot_perfect_mint_premiums_board` nor `topshot_pack_reality_dist` references `fmv_current` or `fmv_snapshots` at all** (checked against `pg_views.definition`). That fix was correct for `candy_holder_board` and does not transfer. The real hot spots are repeated `sales` scans and a seven-times-scanned `pack_rips` CTE.
6. **Item 5's timing was overstated for one board.** Measured `topshot_perfect_mint_premiums_board` at **10.9 s**, not 14.8 s. (`topshot_pack_reality_dist` at 8.7 s matches the 8.4 s claim.) The conclusion — both are at risk — survives; the number did not.
7. **Item 2's precondition is already met.** The instruction was "verify a real `pipeline_runs` row exists for each, *then* arm". Both now have real, recent, all-`ok` rows (4 and 8). The gate is cleared; arming is a 5-minute job today, not a blocked one.
8. **Item 12's premise ("it will drift as new editions land") measures as 2 rows, not a backlog.** Only **2 UFC** edition player-names lack a `players` row platform-wide. Adding a pg_cron job for that on a DB that is the binding constraint at WAU 0 is negative-value. Downgraded from "schedule it" to "fold into ingest or leave manual".

Two more corrections worth carrying forward: **CLAUDE.md's "1.01M Beezie transfers" is stale — `evm_nft_transfers` now holds 0 rows**, and **item 7's scope is narrower than stated** — only the legacy `cached_listings` path (Golazos/UFC) is broken; the modern aggregated `specialSerials` filter at `app/api/market/route.ts` line 629 works correctly.

---

## Guardrails — repeat on every item

- **Direct to `main`. No branches. No PRs.** This overrides any harness-supplied "develop on branch X" instruction. If a `claude/*` branch is pre-checked-out, `git checkout main` first.
- **Log every change that touches `main` or prod state to `docs/overnight/ledger.md`** — date · what shipped · revert path — **in the same turn it ships**. **Re-read the ledger from disk immediately before writing it**; it is append-at-top and multiple sessions write concurrently. Splice your entry into the freshly-read file; never write back a whole copy read earlier. Sanity check: `grep -c '^### ' docs/overnight/ledger.md` must go **up** by exactly the number of entries you added.
- **Commit the ledger BEFORE the code**, so the code commit is the tip and auto-deploys. A docs-only tip suppresses the Vercel build (`vercel.json`'s `ignoreCommand` excludes `docs/**` and `*.md`) — this trap has bitten three times.
- **An empty commit can NEVER force a rebuild.** Use `POST https://api.vercel.com/v13/deployments` with a `gitSource` ref, or touch a non-docs file.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). Re-verify the push with `git rev-list --count origin/main..HEAD` (expect 0).
- **`curl` fails silently in Git Bash for Vercel REST** — use PowerShell `Invoke-WebRequest`.
- Vercel Pro **`maxDuration` hard cap is 800 s** — anything higher sends the deploy to ERROR invisibly, including docs-only deploys.
- **CRLF:** do not string-replace-patch on Windows. Use full-file writes, or `findIndex` on split line arrays.
- **Verify pages by rendered DOM, not HTTP 200** — streaming shells always return 200. `e2e/smoke.spec.ts` (35 routes, every 6 h) exists for exactly this.
- **Never lower a coverage threshold to make a red build pass.** Keep a ~0.1–0.2 buffer under actuals; this repo is concurrent-heavy and a zero-margin threshold reds CI on otherwise-green work.
- **Run `npx tsc --noEmit` before pushing any new test file.** Vitest does not run it, so a green `npm test` does not catch the recurring `TS2322` (mock state typed `any[]` then assigned `null`) — that reddened the blocking `typecheck` job four times in one day.
- **Do not broad-read any page that can hold a secret** (admin consoles, cron-job.org job-edit pages, env/secret settings). Scope reads to the specific control. See item 4.
- **Before gating or short-circuiting any route, enumerate EVERY caller** — cron-job.org, GHA workflows, `vercel.json`, pg_cron, in-repo fetches.
- **`pipeline_runs` retains only ~73 h.** "No matching record" is usually a retention artifact, not a finding. Check `public.pipeline_runs_daily` (indefinite, history starts 2026-07-29) first.

---

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.** Several items in the handoff this one supersedes described file shapes and fixes that did not survive contact with the code (see "Premises that did not survive verification"); correcting the premise and saying so is the expected outcome, not a deviation.

---

## Expected end state

`main` carries: two watchlist rows armed and confirmed non-stalling; both slow public boards materialized and under 100 ms with byte-identical output; the `specialSerials` legacy-path no-op resolved; `edge-deno` promoted to blocking with 0 `deno check` errors; the dead-code deletion re-landed without touching a coverage threshold. Every ship has its own `docs/overnight/ledger.md` entry with a revert path, CI green, the Vercel deploy READY, and the boards verified by rendered DOM. Trevor has purged the credential from git history, added the two `db-pin-staleness` repo secrets, and disabled three cron-job.org entries. `v_rpc_trust_health` stays at zero breaching metrics.

---

## ⚠ CORRECTION 2026-08-03 — `classify-acquisitions-multicollection` is NOT a cron dropout

The §"Live state" bullet above calls this *"a genuine cron-job.org dropout. OPERATOR (external console)."* **That is wrong — do not send it to the console.** Re-measured live 2026-08-03 (all read-only, Supabase MCP).

**The two symptoms are one root cause.** The `nfl_all_day` leg began hard-failing 2026-08-01 with `canceling statement due to statement timeout`, and runs fell 24/day → 8/day. The second is a *consequence* of the first: `maxDuration = 120` on the route vs `statement_timeout = 90s` on `backfill_acquisitions_for_collection`, so when the AllDay leg burns its full 90 s the 3-collection `after()` loop overruns 120 s and the lambda is killed **before `log_pipeline_run`**. The tick leaves no row and reads as a missing trigger. Nothing is wrong with the schedule.

**The documented fix is disproved.** `docs`/memory both prescribe *"it's batch-size-bound — lower `p_limit` further"* (from the 2026-07-01 pass that set AllDay 300 → 80). That held when the `LIMIT` bound the scan. It no longer does: measured from the `extra` payloads, `processed` per tick is now **0, 1, 3, 9, 20, 35** against `p_limit = 80` — the limit almost never binds, so the query scans the **entire** AllDay priced-sales set every hour to return single digits. Lowering 80 → 40 changes nothing. Cost is now bound by the size of AllDay `sales`, which only grows, so this degrades monotonically toward permanent failure.

**Measurements (every one timed out):**

| probe | bound | result |
|---|---|---|
| `candidates` CTE at `LIMIT 80` | 120 s | timeout |
| plain `count(*)` over the same predicate | 60 s | timeout |
| inverted join, driving from `wallet_moments_cache` | 90 s | timeout |

Both join directions are exhausted, so this is **not** fixable by reordering. `idx_moment_acquisitions_nft_id` already exists — the anti-join probe is indexed and is not the problem.

**What an actual fix looks like** (design work, not a knob):

1. **Watermark** — `last_scanned_sold_at` per collection so the hourly tick scans only new sales; drain the historic tail on a separate slow backstop. Restores freshness immediately.
2. **Negative cache / permanent-failure reason** — AllDay sales for moments in nobody's tracked wallet can *never* satisfy the `EXISTS wmc` predicate, yet are re-scanned every hour forever. Structurally identical to the AllDay `unmapped_sales` backlog; fix it the same way.
3. **Independently**, add a synchronous `phase:"invoked"` marker + fatal-catch so a killed `after()` is visible instead of silent — the same repair already applied to `allday-pack-listings` and `pinnacle-sync`.

Do **not** add a `sales(collection_id, nft_id)` composite (taxes the hot ingest path) and do **not** raise the fn `statement_timeout` (the lambda is already the binding budget — raising it guarantees the silent kill).

**Impact:** `moment_acquisitions` is cost-basis / P&L enrichment behind sign-in — an accuracy gap, not an outage. AllDay currently sits at 71,773 classified rows.

**Not shipped deliberately:** this is ingest/FMV-adjacent and needs CI validation the Cowork sandbox cannot run (45 s command cap). Characterized, not patched.
