# Paste-ready ledger entries — append at the TOP of `docs/overnight/ledger.md`

⚠ Written as a separate file deliberately: `ledger.md` is 1,138 entries, append-at-top and
concurrent-write-heavy, and the mount has welded a heading onto line 9 once before. **Do not let a
cloud session write it.** Paste the block below under the existing top-matter, above the
`### 2026-08-09 · SHIPPED — DB (Claude Code, interactive) · D13` entry.

---

### 2026-08-09 · SHIPPED — DB (Cowork cloud nightly) · a function's `SET statement_timeout` is INERT, and it had 8 cron jobs silently capped at 120s

`check_pgcron_recent_failures()` listed six jobs; chasing *why* they died produced a general defect rather than six incidents. **Every affected job dies at exactly 120.0 s** — the *global* `statement_timeout` from `platform-defaults.conf` — while the plpgsql function each one calls declares **180–600 s** in its `proconfig`. A function-level `SET statement_timeout` **cannot change the budget of the statement that calls it**: the timer is armed by `start_xact_command()` before the function's GUC nest level is entered.

**Proven with two positive controls against prod, not inferred.** Probe A: a function declaring `statement_timeout='1s'` running `pg_sleep(3)` **completed** (cannot lower). Probe C: session at `1s`, function declaring `'200s'`, `pg_sleep(3)` → **canceled at 1 s**, with the same error `CONTEXT` shape as all six production failures (cannot raise). All three probe functions dropped; 0 remain. **Corroborated independently in the existing failure record:** jobid 256 `rpc-thin-sale-ask-disclosure-refresh` runs as `cron_heavy` (role = 600 s) and its function claims **900 s** — its longest run ever is **602 s**. The role governs in both directions.

**Impact found:** jobid **259 `rpc-reconcile-saved-wallet-stats` had NEVER succeeded** (0 ok / 1 run since it shipped on 08-09) · jobid **54 `rpc-allday-serial-fmv-jersey`** is weekly and failed its 08-09 tick, so its last success was 08-02 — a **14-day gap** · jobid **4 `rpc-ccm-step2`** is 31/31 but its longest run is **113.9 s, 4.9 s from the cliff** · plus jobids 5, 36, 49, 50, 199.

**Fix (migration `20260810040308_audit_20260809_cron_statement_timeout_prefix_for_inert_proconfig_jobs`):** an in-command `SET statement_timeout = '<N>s'; ` prefix — the pattern jobids 235/236/237/240/241/245/248 already use — with **each job given the value its own function declares**, honouring the original author's intent rather than inventing a number. The splice is guarded: it asserts the `(jobid, jobname)` pair, refuses a double prefix, and requires the command still be a bare `SELECT public.<fn>()`, raising rather than passing silently.

⚠ **Deliberately NOT repointed to the `cron_heavy` role** (my first instinct): `cron_heavy` has **no EXECUTE grant** on 3 of the 8 functions, so that path needed privilege changes. The prefix needs none.

⚠ **jobid 37 `rpc-refresh-sets-summary` left alone on purpose** — claims 300 s, longest run ever **3.0 s**, 40× headroom. Raising a budget is not free: a doomed run squats a pg_cron worker slot for the whole budget, which is the mechanism behind the `job startup timeout` class this ledger has been fighting. Raised only where the evidence showed a real or imminent gap, and the raised set is weekly/daily except jobid 36.

**Positive control on the FIX, not the diagnosis:** fired jobid 259's *new* command as a one-off — **succeeded in 37.0 s** and refreshed **78 of 99 `saved_wallets` rows**, caches that job had never once written. ⚠ **37 s means tonight's quiet DB never exercised the new 300 s budget**; the control proves the function works, and the 120 s cap is what killed its contended 13:33Z run. **Refutation condition: if it ever fails at exactly 300.0 s, the budget is too small — not inert.**

**Target metric:** zero `canceling statement due to statement timeout` at 120.0 s among these 8 jobs; jobid 259 `last_ok` stops being NULL.
**Revert (DB):** `SELECT cron.alter_job(<jobid>, command => <pre-migration text>);` — all 8 exact originals are in the migration file header. **Revert (repo):** `git revert <sha>` removes the file only.

---

### 2026-08-09 · SHIPPED — DB (Cowork cloud nightly) · the six serial-1 partial indexes; the "operator-only" premise was wrong

Drains `docs/overnight/inbox/2026-08-09T1941Z.md` **Fix 1**, which had been parked because *"`CONCURRENTLY` cannot run via the Supabase MCP (not txn-safe; the ~60 s tool cap would abort on a hot partition leaving an INVALID index)"*. That is correct about the MCP but does not follow for Cowork.

💡 **A one-off pg_cron job runs its command over a fresh libpq connection outside any transaction block, so `CREATE INDEX CONCURRENTLY` works there — and there is no 60 s client cap.** Same server-side-execution trick already recorded for long `EXPLAIN`s, applied to DDL. **This converts a whole class of parked "operator-only, SQL-editor-required" DDL into shippable work.**

Built `idx_sales_<Y>_serial1 ON public.sales_<Y> (collection, edition_id, sold_at DESC) WHERE serial_number = 1` for Y in 2020..2025 — byte-mirroring the proven `idx_sales_2026_serial1`. All six `indisvalid = true`; **400 kB total** for 4,971 serial-1 rows. Build times **2020 110.6 s · 2021 110.6 s · 2022 50.3 s · 2023 194.3 s · 2024 2.7 s · 2025 480.4 s**.

⚠ **Build time does not track partition size** — it is dominated by CIC's phase-3 wait on concurrent transactions (`Lock: virtualxid`), not the heap scan: 2022 (178 MB heap) took 50 s while 2020 (35 MB) took 111 s. ⚠ **The inbox item's "2020 78 MB · 2023 822 MB" are *total* sizes including indexes**; heap — what the build scans — is 35–303 MB.

⚠ **2024's first attempt failed as `job startup timeout`** — pg_cron never started it because 2025's 8-minute build was squatting a worker slot. **It left no partial index** and succeeded on retry. A live instance of the third-status class, caused by my own 6-minute stagger being too tight.

**Measured (planner-only `EXPLAIN`, safe under IO throttling) on `topshot_2025_rookie_index`, the `/insights/rookies` board:** total plan cost **79,591.62 → 8,857.85 (−88.9%)**; the mint-#1 trophy node **76,275.06 → 5,541.35 (−92.7%)**; per-edition `Append` **778.22 → 56.44**. Per partition 2020 52.63→1.43 · 2021 58.18→1.68 · 2022 248.23→1.74 · 2023 205.06→9.94 · 2024 103.97→12.75 · 2025 94.40→13.17 — the planner picks the new partial on every one.

⚠ **This is planner cost, not time.** The claim I stand behind is that the leg the inbox item identified as ~76 k of the ~79.6 k is gone and the trophy lookup is no longer the dominant node. **Post-ship watch is the real metric: whether `deals` and `rookies` now warm reliably in the nc1 snapshot ticks** — that was the user-facing symptom.

**The temporary role change, made safe:** the 120 s global cap is not enough for CIC's wait phase, and `cron_heavy` cannot create indexes on `postgres`-owned tables, so `ALTER ROLE postgres SET statement_timeout='600s'` covered the build window (04:03–05:09 Z). **The revert was scheduled as a pg_cron job BEFORE the change was made**, so it would self-heal if the session died. ✅ Reverted 05:09:24Z, `pg_roles.rolconfig` back to `search_path` only; ✅ all 8 one-off jobs unscheduled, **81 active jobs = the starting count**; ✅ 0 invalid indexes. ⚠ `cron.unschedule` cascade-deletes that job's `cron.job_run_details` rows — the timings above survive only because they were copied into the migration header first.

**Record migration:** `20260810045029_audit_20260809_serial1_partial_indexes_historical_sales_partitions_record` — asserts all six exist and are valid, raising if not. It cannot build them (`apply_migration` wraps a transaction).
**Revert (DB):** `DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_<Y>_serial1;` for Y in 2020..2025, each independent, from the SQL editor or a one-off pg_cron job. **Revert (repo):** `git revert <sha>` removes the file only.
