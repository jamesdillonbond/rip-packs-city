# 📏 Five `postgres`-owned cron jobs are clipped at the **DB-default 120 s** purely because their command lacks the two-statement `SET statement_timeout` prefix — 18 sibling jobs already have it

**Filed:** 2026-08-31 ~07:25 PT (14:25Z) · **By:** Claude Code, Trevor's box, overnight pass
**Class:** timeout-model / configuration gap · **Status:** ⚠ **PARTLY CORRECTED — read the SELF-CORRECTION at the foot BEFORE acting.** ⛔ Not applied.

> ⛔ **TWO CORRECTIONS, both found by grepping my own memory store 20 minutes too late.** (1) **This is a REDISCOVERY** — the mechanism, the fix pattern and jobid 259 by name are in `postgres-timeout-model` and were shipped 2026-08-10 (migration `20260810040308`, 8 jobs); **7 of those 8 still carry the prefix today.** (2) 🚨 **The recommendation is WRONG for jobid 259, the one §3 calls "the sharpest": it is a PROCEDURE (`prokind='p'`, `CALL …`), and the prefix CANNOT be applied to it** — pg_cron wraps a multi-statement command in one transaction and this procedure COMMITs internally, raising `2D000`. Its missing prefix is **correct and deliberate**. The four FUNCTION cases (261, 78, 11, 87) stand.

---

## 1. The controlled comparison — same role, same scheduler, one variable

Three `postgres`-owned pg_cron jobs, differing **only** in the shape of `cron.job.command`:

| jobid | command form | successes | **successes > 120 s** | max ok | failures |
|---|---|---:|---:|---:|---|
| **235** `rpc-refresh-market-index-daily` | `SET statement_timeout = '600s'; REFRESH …` | 62 | **26** | 598.0 s | 15, **min 600.0 s** |
| **236** `rpc-refresh-perfect-mint-premiums` | `SET statement_timeout = '600s'; REFRESH …` | 159 | **98** | 606.7 s | 9 |
| **261** `rpc-refresh-unmapped-backlog-growth` | `SELECT public.refresh_…();` — **no SET** | 259 | **0** | **119.5 s** | 66, killed at **120.1 s** |

**124 successes above 120 s where the prefix exists; ZERO in 259 where it does not, with a hard ceiling
of 119.5 s.** And 235's failures bottom out at exactly **600.0 s** — its declared value — which is the
positive control that the `SET` really took effect rather than the job simply being fast.

⭐ **Three facts fall out, and they sharpen the recorded timeout model rather than contradicting it:**

1. **The cron command's two-statement `SET statement_timeout = 'X'; <stmt>;` IS effective.** It is a
   separate top-level statement on the same session, so the statement after it inherits X.
2. **A function's own `SET statement_timeout` is INERT on the pg_cron path** — exactly as CLAUDE.md
   records. `refresh_unmapped_backlog_growth` declares **90 s** and its kills land at **120.1 s**, never
   90. If the declaration bound anything, the kills would be at 90.
3. **Without the prefix a job inherits the DATABASE-level default**, which is
   `statement_timeout = 120000` (`pg_settings.source = 'configuration file'`). Not the role's — the
   `postgres` role carries no `statement_timeout` at all.

## 2. How much of the fleet is in this shape

Active jobs by owner and command form:

| owner | has `SET` prefix | jobs |
|---|---|---:|
| `cron_heavy` | no | 47 |
| `postgres` | no | **36** |
| `postgres` | **yes** | 18 |

ⓘ **`cron_heavy`'s 47 are NOT in scope** — that role carries `statement_timeout=600s` in `rolconfig`, so
they get 600 s without a prefix. The exposure is the **36 `postgres`-owned jobs with no prefix**, which
fall through to the 120 s database default.

## 3. The five clean cases

Filtering to jobs whose successes **never reach 120 s** *and* which are being killed in the 119–126 s
band — i.e. unambiguously clipped rather than merely occasionally slow:

| jobid | jobname | max ok | kills at ~120 s (14 d) |
|---|---|---:|---:|
| **259** | `rpc-reconcile-saved-wallet-stats` | **118.3 s** | **53** |
| 261 | `rpc-refresh-unmapped-backlog-growth` | 119.5 s | 50 |
| 78 | `rpc-backfill-pinnacle-acquisitions` | 119.4 s | 18 |
| 11 | `rpc-refresh-new-collectors` | 113.7 s | 5 |
| 87 | `rpc-refresh-challenge-costs` | 105.1 s | 5 |

**259 is the sharpest**: 266 successes, none above 118.3 s, and 53 kills sitting on the wall. That is a
distribution whose right tail is being cut off, not a job with a fault.
ⓘ 261 is already addressed from the other side — an `OFFSET 0` fence shipped this pass took its function
1,550 ms → 560 ms. It is listed here because it is the case that *proved* the mechanism.

## 4. ⚠ What is NOT established

**That all 13 prefix-less jobs with 120 s-band kills are clipped.** Two of them have successes far above
120 s with no prefix — `302 rpc-backfill-wmc-fmv-confidence` (max ok **370.3 s**) and
`231 rpc-golazos-badge-low-ask-refresh` (**252.1 s**). **Queue wait explains that without contradicting
anything** — `cron.job_run_details` duration is measured from `start_time`, which includes time spent
waiting for a worker, so a recorded 370 s can be a 120 s statement behind 250 s of queue. **But I did not
separate the two**, so those rows are excluded from §3 rather than counted. The five in §3 are the ones
where the ceiling reading is unambiguous.

⚠ Also NOT established: that any of the five would *complete* with more budget. A clipped tail says the
work does not fit in 120 s; it does not say it fits in 600 s.

## 5. ⛔ Why nothing was applied, and the order to do it in

**Raising a ceiling is the one lever known-issues #42 explicitly warns about** — *"raising a budget can
cut failures while raising waste, and only `wasted_s` tells them apart."* A job that currently wastes
120 s per kill would waste up to 600 s per kill instead. **That is a real cost on the instance's binding
constraint, and it is not obviously worth paying for a metrics refresher.**

👉 **#42's own ordering applies and should be followed per job, not in a batch:**
1. **Find out whether it CAN complete before tuning anything** — run the job's statement manually with a
   raised budget and see whether it finishes at all, and in what.
2. **Only then** consider the one-line change: `cron.alter_job` to prepend
   `SET statement_timeout = 'Ns'; ` to the command, matching the 18 siblings that already do this.
3. **Watch `wasted_s`, not the failure count.** The failure count will fall either way.

⛔ **Do NOT apply this fleet-wide as a sweep.** Thirty-six jobs share the shape and most of them are
nowhere near 120 s — for those the prefix is a no-op that adds a statement, and the five in §3 are the
only ones with evidence.

⭐ **The transferable part: the ceiling a pg_cron job actually gets is decided by the COMMAND, not by the
function.** Three places declare a timeout here and only one of them binds on this path — so read
`cron.job.command` first, and treat a function's `SET statement_timeout` as documentation until proven
otherwise. A job whose successes stop dead just under a round number is being clipped, and `max(success
duration)` is the cheapest way to see it.

---

## ⛔ SELF-CORRECTION — 2026-08-31 ~07:45 PT (14:45Z), ~20 minutes after filing

**Two things are wrong above, and I found both by doing what I should have done BEFORE filing: grepping
my own memory store.** [[grep-the-memory-store-before-publishing-a-measurement]] is a rule I hold and did
not follow.

### 1. ⛔ This is a REDISCOVERY, not a discovery

The mechanism, the fix pattern, and even **jobid 259 by name** are already recorded in
`postgres-timeout-model` and were **shipped on 2026-08-10** as
`supabase/migrations/20260810040308_audit_20260809_cron_statement_timeout_prefix_for_inert_proconfig_jobs`,
which prefixed **8 jobs** (4, 5, 36, 49, 50, 54, 199, 259) with both positive controls already proven.
📏 **Checked today: 7 of those 8 still carry the prefix and are working.** So the pattern is live,
understood, and not news. What survives from §1–§3 is only the *current* list of jobs still exposed.

### 2. 🚨 THE RECOMMENDATION IS WRONG FOR jobid 259 — the one I called "the sharpest"

**`259` is a PROCEDURE, not a function**: `prokind = 'p'`, and its command is
`CALL public.reconcile_all_saved_wallet_stats(10, 40, 360);`.

⛔ **The `SET statement_timeout = 'N'; …` prefix CANNOT be applied to it.** pg_cron wraps a
multi-statement command in ONE transaction, and this procedure `COMMIT`s internally — which raises
**`2D000 invalid transaction termination`**. That is recorded in the same memory:
*"the prefix trick works only for `SELECT fn()` jobs."* **259's lack of a prefix is therefore CORRECT and
deliberate, not the oversight I presented it as** — it is the one job of the 8 that could not take the fix.

⚠ **And a COMMIT does not re-arm the timer either**, so 259 cannot buy budget that way: the whole `CALL`
is one top-level statement under one budget no matter how many times it commits.

👉 **259's actual lever is its ARGUMENTS, not its ceiling.** It is a *bounded* procedure — `(10, 40, 360)` —
so the way to fit it inside 120 s is to do less per call, not to ask for more time. That is a different
change with a different risk profile (it slows reconciliation throughput rather than spending IO), and it
is not the one-liner §5 implied.

### What still stands

**Four of the five are functions invoked with `SELECT` and the prefix genuinely applies to them:**
**261** (already addressed from the other side this pass), **78** `backfill_pinnacle_acquisitions`,
**11** `refresh_insights_new_collectors`, **87** `refresh_challenge_costs` — all `prokind = 'f'`.
§5's ordering still governs: **find out whether it CAN complete before tuning anything**, then the
one-liner, then watch `wasted_s`.

⭐ **The transferable lesson is now sharper than the one §5 ended with: before applying the prefix, check
`prokind`.** A `CALL` to a committing procedure looks exactly like a `SELECT` to a function in
`cron.job.command`, and the fix that helps one **errors** on the other — so the check is one column, and
skipping it turns a working job into a broken one.
