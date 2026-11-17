# The master alarm goes blind under the exact condition it exists to catch — **3 of 11 arms INCONCLUSIVE and rising 0 → 1 → 2 → 3 in seven hours** — and the marker an observer would count is **not applied uniformly**

*Claude Code (cloud), 2026-09-13 10:2x PT. **READ-ONLY.** Measurable for the first time today: the per-check detail this rests on was **built, sent to Telegram and then DROPPED** until `sentinel.extra.findings` shipped at ~02:46 PT. Every number here comes from four runs, so treat the TREND as suggestive and the DEFECT in §2 as established.*

---

## 1. The arms that cannot answer are the ones saturation silences

Live read, sentinel run **09:51 PT**, 11 findings:

| arm | detail |
|---|---|
| **Sales Ingest (2h)** | `INCONCLUSIVE (db saturated) — Query error:` |
| **Trust Health** | `INCONCLUSIVE (db saturated) — Query error: canceling statement due to statement timeout` |
| **Sniper Feed** | `INCONCLUSIVE (db saturated) — Timeout or error: This operation was aborted` |
| **Pipeline Success** | `RPC error: canceling statement due to statement timeout` |

⭐ **This is the honesty pattern WORKING — an arm that cannot read says so instead of publishing a clean.** That is the right behaviour and must not be "fixed". ⛔ **The problem is the consequence: the fleet is LEAST observable exactly when it is MOST degraded**, because the same saturation that breaks the lanes breaks the queries that watch them.

**Trend across every run that carries findings** (the instrument is 7 h old, so this is all of them):

| run (PT) | findings | INCONCLUSIVE |
|---|---:|---:|
| 02:46 | 8 | **0** |
| 03:30 | 9 | **1** |
| 07:36 | 9 | **2** |
| 09:51 | 11 | **3** |

⚠ **Four points is not a rate.** It is consistent with the saturation this estate already tracks (#42/#104), and it is the first time the quantity has been observable at all.

## 2. ⛔ THE ESTABLISHED DEFECT: the blind-marker is inconsistent, so counting it UNDERCOUNTS

**Three arms carry the literal string `INCONCLUSIVE`. `Pipeline Success` is equally blind — killed by the same statement timeout — and does NOT.** It emits a raw `RPC error: …`.

🚨 **So `count(*) WHERE detail ILIKE '%INCONCLUSIVE%'` returns 3 when the true number is 4.** I wrote exactly that query and got exactly that undercount, which is how this was found.

⭐ **This is CLAUDE.md's own rule — *"FIXING A GUARD WITHOUT FIXING ITS RECORD leaves the incidence unmeasurable; fix the guard AND the field an observer keys on"* — applied to the master alarm itself.** An arm degrading to an unmeasured state with a non-standard marker is invisible to any future health query, including the one a night pass would naturally write.

**The fix is small and belongs in `app/api/sentinel/route.ts`:** every arm that fails to READ (as distinct from reading and finding a problem) should emit one agreed prefix — `INCONCLUSIVE` — so blindness is countable. ⚠ **NOT changed here deliberately:** a concurrent session is actively shipping that file today (the coverage arm, the Wall Kills arm, `apply-fmv-haircut` wall logging), and this is a reporting nicety against their live work. **Collision risk outweighs the benefit of doing it now.**

## 3. What else that run says, recorded so it is not lost

- **`pg_cron Failures (6h)`: 268 of 2,326 runs failed across 44 jobs** — **102 worker-slot `startup timeout`**, 166 cancelled at a statement budget. ⭐ The startup-timeout share points at `max_worker_processes = 6` contention, which is a **config ceiling**, not a slow query.
- **`Wall Kills (24h)`**: `fmv-recalc` **32/151 = 21.2%**, `drain-fmv-cold-tail` **11/46 = 23.9%** — this is register **#107**, filed by the concurrent session hours ago; recorded here only as corroboration from a second reading.
- **`Alert Delivery`: `email-FAILED:not_configured`** while Telegram delivers. A channel that has never been configured reads identically to one that broke.
- **`Pipeline Silence`: `apply-fmv-haircut` silent 2,537 min (~42 h)** — the concurrent session shipped wall-kill logging for this lane today.

## 4. ⛔ What this does NOT say

**FMV is NOT stale despite all of the above, and that surprised me.** Measured directly: newest `fmv_snapshots.computed_at` is **0.2 h old**, **24,716** snapshots computed in 24 h, **116,921** in 7 d. ⭐ **So `fmv-recalc` being wall-killed on 21% of ticks has NOT produced user-visible staleness** — the kills are partial and the surviving ticks keep the surface current. **Do not escalate #107 on a staleness argument without re-deriving that; the obvious inference is refuted.**

---

# ⛔ ADDENDUM, SAME SESSION — DE-CLUSTERING THE SCHEDULES IS REFUTED FOR THE STARTUP TIMEOUTS. Do not attempt it.

The obvious response to *"102 worker-slot `startup timeout`s against `max_worker_processes = 6`"* is to spread the schedules out. **Measured over 12 h, it would change nothing — and the data points the opposite way to the intuition.**

Startup timeouts per minute-of-hour, against how many **fixed-minute** jobs are scheduled on that minute:

| minute | startup timeouts | fixed jobs on that minute |
|---:|---:|---:|
| 52 | **9** | 2 |
| 50 | 7 | 5 |
| **36** | **7** | **0** |
| 54 | 7 | 1 |
| **6** | **6** | **0** |
| **2** | **6** | **0** |
| **18** | **6** | **0** |
| **4** | **6** | **0** |

⭐ **Six of the ten worst minutes have ZERO fixed-schedule jobs on them.** The heaviest fixed minute in the whole fleet (minute 48, 6 jobs) does not appear in the top ten at all. **There is no relationship between fixed-minute pileups and worker-slot starvation.**

**Why, and it matches this estate's existing model:** a startup timeout means no worker slot was free, and slots are held by whatever is *already running* — `*/N` lanes and long jobs — not by whatever happens to START on that minute. ⭐ **CLAUDE.md already records the general form of this** (*"the old framing sends you to de-cluster schedules, which would change nothing"*) for the `statement timeout` class; **this is the same conclusion re-derived independently for the `startup timeout` class, which the register notes had RETURNED with the IO.**

👉 **So the lever is the long-running work holding slots — register #104's fan-out is the largest single source — not the schedule layout.** ⚠ **And raising `max_worker_processes` is a postmaster setting: it needs a restart, and this instance has not restarted in ~81 days. That is an infrastructure decision, not an engineering one.**

⛔ **Recorded because the reschedule is cheap, obvious, reversible and USELESS — exactly the shape of work that gets done because it is easy rather than because it helps.**
