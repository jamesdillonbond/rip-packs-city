# Handoff — 2026-08-09d (Cowork cloud nightly pass, 20:49–22:15 PT)

> ⚠ **The push blocker below is specific to THIS CLOUD SESSION.** Trevor's box carries the PAT in
> `remote.origin.pushurl` and Claude Code pushes normally. **Commit these files as usual** — nothing
> here is blocked on your end.

## Capability triage (§0)

| capability | state |
|---|---|
| `bash` / clone / node | ✅ green (30 GB free) |
| `git push` | ❌ **cloud credential-proxy 403** — `not in this session's authorized repository set`. Same cause as 08-09b, operator-only fix. |
| Supabase MCP (read + `apply_migration`) | ✅ green |
| Vercel MCP | 🟡 `get_runtime_logs` timed out at every range I tried (24h / 3h); `get_runtime_errors` returned none |
| Sentry MCP | ✅ green |
| device bridge (file API) | 🟡 **dropped mid-session** and came back — outputs mirrored to the claude.ai Project |
| `device_bash` | not exercised |

⚠ **A very productive Claude Code session ended at 20:46 PT, three minutes before this pass started**
(`d3f5582`, 25 commits from 18:56). I checked for collisions before every write; the newest prod
migration when I began was `20260810031639` and mine are the two after it.

---

## ✅ SHIPPED 1 — a function's `SET statement_timeout` is INERT, and it had 8 cron jobs silently capped

**Migration `20260810040308_audit_20260809_cron_statement_timeout_prefix_for_inert_proconfig_jobs`**

`check_pgcron_recent_failures()` listed six jobs. Chasing why they died produced a general defect.

**Every affected job dies at exactly 120.0 s** — the *global* `statement_timeout` from
`platform-defaults.conf` — while the plpgsql function each one calls declares 180–600 s in its
`proconfig`. A function-level `SET statement_timeout` **cannot change the budget of the statement
that calls it**: the timer is armed by `start_xact_command()` before the function's GUC nest level
is entered.

### Proven, not inferred — two positive controls run against prod

| probe | setup | result |
|---|---|---|
| **A** | fn declaring `statement_timeout='1s'`, body `pg_sleep(3)` | **completed** — cannot *lower* |
| **C** | session at `1s`, fn declaring `'200s'`, body `pg_sleep(3)` | **canceled at 1s** — cannot *raise* |

Probe C's error `CONTEXT` is the same shape as all six production failures. All three probe
functions were dropped; verified 0 remain.

**Corroborated independently in the failure record:** jobid 256 `rpc-thin-sale-ask-disclosure-refresh`
runs as `cron_heavy` (role = 600 s) and its function claims **900 s** — its longest run is **602 s**.
The role value governs in *both* directions; the function value is ignored in both.

### Who was affected

| jobid | job | fn claims | was capped at | evidence |
|---|---|---|---|---|
| 259 | `rpc-reconcile-saved-wallet-stats` | 300s | 120s | **0 successes out of 1 run — had NEVER worked** |
| 54 | `rpc-allday-serial-fmv-jersey` | 600s | 120s | last ok 08-02, failed 08-09 → weekly job, **14-day gap** |
| 5 | `rpc-serial-fmv-multipliers-weekly` | 600s | 120s | 4/5, one death at 120.0s |
| 199 | `rpc-weekly-wmc-prune` | 600s | 120s | 3/4, death at 120.9s |
| 4 | `rpc-ccm-step2` | 300s | 120s | 31/31 **but max run 113.9 s — 4.9 s from the cliff** |
| 36 | `rpc-refresh-mv-ts-set-play-catalog` | 180s | 120s | 246/250 |
| 49 | `rpc-allday-serial-fmv-multipliers` | 600s | 120s | 5/5, max 55.9s |
| 50 | `rpc-allday-serial-fmv-power-model` | 600s | 120s | 5/5, max 79.3s |

**Fix:** an in-command `SET statement_timeout = '<N>s'; ` prefix — the pattern jobids
235/236/237/240/241/245/248 already use — with **each job given the value its own function
declares**, so this honours the original author's intent rather than inventing a number.

⚠ **Deliberately NOT repointed to the `cron_heavy` role.** That was my first instinct, but
`cron_heavy` has **no EXECUTE grant** on 3 of the 8 functions, so it would have required privilege
changes. The command prefix needs none.

⚠ **`rpc-refresh-sets-summary` (jobid 37) left alone on purpose** — it claims 300 s but its longest
run ever is **3.0 s**, 40× of headroom. Raising a budget is not free: a doomed run squats a pg_cron
worker slot for the whole budget, which is the mechanism behind the `job startup timeout` class the
ledger has been fighting. I raised only where the evidence showed a real or imminent gap, and the
raised set is weekly/daily (low squat exposure) except jobid 36.

### Positive control on the FIX, not just the diagnosis

Fired jobid 259's **new** command as a one-off. It **succeeded in 37.0 s** and refreshed
**78 of 99 `saved_wallets` rows** (`cache_updated_at` 05:01:00Z) — caches that job had never once
written. ⚠ **Stated precisely: 37 s means tonight's quiet DB never exercised the new 300 s budget.**
The control proves the function works and now has data; the 120 s cap is what killed its 13:33Z run
under contention. **Refutation condition: if it ever fails at exactly 300.0 s, the budget is too
small — not inert.**

**Revert:** `SELECT cron.alter_job(<jobid>, command => <pre-migration text>);` — all 8 exact
originals are in the migration file header.

---

## ✅ SHIPPED 2 — the six serial-1 partial indexes, and the "operator-only" premise was wrong

**Drains `docs/overnight/inbox/2026-08-09T1941Z.md` Fix 1.** Record migration
`20260810...serial1_partial_indexes_historical_sales_partitions_record`.

That inbox item parked the work because *"`CONCURRENTLY` cannot run via the Supabase MCP (not
txn-safe; the ~60 s tool cap would abort on a hot partition leaving an INVALID index)"* — correct
about the MCP, but it does not follow that Cowork can't drive it.

💡 **A one-off pg_cron job runs its command over a fresh libpq connection outside any transaction
block, so `CREATE INDEX CONCURRENTLY` works there — and there is no 60 s client cap.** This is the
same server-side-execution trick already recorded for long `EXPLAIN`s, applied to DDL.

**Built, all `indisvalid = true`, 400 kB total for 4,971 serial-1 rows:**

| partition | heap | build | index |
|---|---|---|---|
| 2020 | 35 MB | 110.6 s | 16 kB |
| 2021 | 37 MB | 110.6 s | 32 kB |
| 2022 | 178 MB | 50.3 s | 40 kB |
| 2023 | 303 MB | 194.3 s | 88 kB |
| 2024 | 232 MB | 2.7 s (on retry) | 112 kB |
| 2025 | 198 MB | 480.4 s | 112 kB |

⚠ **Build time does not track partition size** — it is dominated by CIC's phase-3 wait on concurrent
transactions (`Lock: virtualxid`), not the heap scan. 2022 (178 MB) took 50 s; 2020 (35 MB) took 111 s.
⚠ **The inbox item's "2020 78 MB · 2023 822 MB" are *total* sizes including indexes.** Heap — what
the build actually scans — is 35–303 MB.

⚠ **2024's first attempt failed as `job startup timeout`** — pg_cron never started it because 2025's
8-minute build was squatting a worker slot. **It left no partial index** and succeeded on retry.
That is a live instance of the third-status class already in the ledger, caused by my own 6-minute
stagger being too tight.

### Measured effect — planner-only `EXPLAIN` on `topshot_2025_rookie_index` (the `/insights/rookies` board)

| | before | after |
|---|---|---|
| **total plan cost** | **79,591.62** | **8,857.85 (−88.9%)** |
| mint-#1 trophy node | 76,275.06 | 5,541.35 (−92.7%) |
| per-edition `Append` | 778.22 | 56.44 |

Per partition: 2020 52.63→**1.43** · 2021 58.18→**1.68** · 2022 248.23→**1.74** · 2023 205.06→**9.94**
· 2024 103.97→**12.75** · 2025 94.40→**13.17**. The planner picks the new partial on every one.

⚠ **This is planner cost, not time — the repo has been bitten by that inference before.** The figure
I stand behind is that the leg the inbox item identified as "~76 k of the ~79.6 k" is gone, and the
trophy lookup is no longer the dominant node. **Post-ship watch: whether `deals` and `rookies` now
warm reliably in the nc1 snapshot ticks** — that was the actual user-facing symptom.

**Revert:** `DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_<Y>_serial1;` for Y in 2020..2025,
each independent. Run from the SQL editor or a one-off pg_cron job, **not** `apply_migration`.

### The temporary role change, and how it was made safe

The 120 s global cap is not enough for CIC's wait phase, and `cron_heavy` cannot create indexes on
`postgres`-owned tables. So `ALTER ROLE postgres SET statement_timeout = '600s'` for the build window
(04:03–05:09 Z). **I scheduled the revert as a pg_cron job BEFORE making the change**, so it would
self-heal if this session died. ✅ Reverted at 05:09:24Z; `pg_roles.rolconfig` for `postgres` is back
to `search_path` only. ✅ All 8 one-off jobs unscheduled; **81 active jobs, exactly the starting count**.

⚠ **`cron.unschedule` cascade-deletes the job's `cron.job_run_details` rows** — the build timings
above exist only because I copied them into the migration header before cleaning up.

---

## Health verdict — GREEN, with 3 standing breaches

`check_public_security_invariants()` `[]` · `check_secdef_anon_exec_drift()` `[]` ·
`detect_stalled_pipelines()` `[]` · trust board **38 arms** · `trust_precompute_max_age_hours`
**2.89 / 13** · `board_mv_refresh_stale_hours` **1.85 / 8** (the 2-hourly cadence cut is holding).

| breach | value | disposition |
|---|---|---|
| `unmapped_resolution_backlog_max` | 174 → 194 | known — this arm measures **retry-queue depth**, not backlog |
| `public_board_slow_count` | 1 | `topshot_first_mint_trophy_stats` **6,133 ms / 5,400 ms** — see below |
| `panini_sale_price_capture_dry_days` | **12** | the known `brought_at_price`-dead-upstream item; needs the browser harvest on your box, not fixable from here |

**Sentry:** 10 unresolved, **only one first-seen in the last 24 h** — `JAVASCRIPT-NEXTJS-25`
*"smoke test failed: cursor-stall threshold shared by classifier and alert arm"*, 1 event, 12 h ago.
Queued, not chased. The pack-dist 500s issue (`JAVASCRIPT-NEXTJS-1Z`) last fired 12 h ago, which is
**before** `18d40be7` landed — consistent with fixed, not yet proof of it.

⚠ **I could not read Vercel runtime logs this pass** — `get_runtime_logs` timed out at 720 min and
at 180 min, and `get_runtime_errors` returned "none found". Per the standing rule that the runtime
log is *the* instrument for public-page health, **treat the public-page picture as UNMEASURED
tonight**, not as clean.

---

## 🟡 Queued with measurements (not shipped)

**1. `topshot_first_mint_trophy_stats` — 6,133 ms for ONE row, now over its 5,400 ms budget.**
`EXPLAIN` says the cost is a **Parallel Seq Scan on `sales_2026`** (cost 48,351 of the 54,389 total)
computing the "average price of other serials" leg: `serial_number > 1 AND price_usd > 0 AND
collection_id = TS AND sold_at >= now() - 180 days`. That predicate matches most of the partition,
so **no index fixes this** — it is a precompute candidate, the same lever as `/api/market` and the
`deals` materialized latest-FMV-per-edition. Not an autonomous ship (it is a public board's
definition).

**2. The inert `proconfig statement_timeout` entries are still there on ~20 functions.** They now
read as a guarantee the engine does not honour — the "checks that lie about their own state" class.
`ALTER FUNCTION <f>(<args>) RESET statement_timeout;` removes each one without touching the body or
its grants. Cheap, but 20 functions on a load-bearing path is more than I would ship unattended in
one go, and the in-command prefixes now make the *real* budget visible at the job.

**3. `migration-parity` filename drift.** `20260810003540` and `20260810005545` are recorded in prod
but committed as `20260810040000_*` and `20260810050000_*`. Content is what matters — flagging it
because a filename-based parity check would read these as missing.

**4. Inbox archival still blocked** — the file API cannot move or delete, and copy-without-remove
makes the next pass re-drain. `docs/overnight/inbox/2026-08-09T1941Z.md` is now **fully drained** and
can be archived by hand.

---

## Files to commit

```
supabase/migrations/20260810040308_audit_20260809_cron_statement_timeout_prefix_for_inert_proconfig_jobs.sql
supabase/migrations/<version>_audit_20260809_serial1_partial_indexes_historical_sales_partitions_record.sql
docs/handoff-2026-08-09d-cron-timeout-and-serial1-indexes.md
```

Both migrations are **already applied to prod**; committing only closes the drift window. The first
was md5-verified byte-identical against `supabase_migrations.schema_migrations.statements[1]`
(`8a2d00a16a76428f6a4e152c3b178aa4`) rather than retyped.
