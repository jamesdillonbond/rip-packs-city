# `fmv-recalc` has completed NOTHING for 90 minutes and `fmv_sweep_wedge_hours` is breaching — and it kept killing AFTER the IO band cleared

**2026-08-29 13:3x PT / 20:3xZ · Claude Code (Trevor's box)**
**Found by a closing health sweep, not by looking for it. FILED, NOT ACTED ON — this is the documented `fmv-recalc` item and it is Trevor's/the roadmap's, not a thing to change at this hour.**

---

## The measurement

| instrument | reading | threshold |
|---|---:|---:|
| `fmv_sweep_wedge_hours` (trust arm) | **4.30 h and rising** | BREACH at 3 |
| last terminal `fmv-recalc` row | **2026-08-29 18:48:06Z** | — |
| last `fmv-recalc-heartbeat` | 2026-08-29 20:15:46Z | — |
| **terminal rows, last 90 min** | **0** | — |
| **heartbeats, last 90 min** | **8** | — |
| 24 h totals | 146 heartbeats / **59 terminal** (59.6% killed) / 25,515 rows written | documented 64–73% |

**Every heartbeat carries `{"phase":"started","offset":0,...}` — the sweep starts at page 0 on every
invocation.**

## ⚠ What this is NOT — the two ways to over-read it, both refuted here

1. ⛔ **It is not a kill-streak alarm.** This repo's own rule is *"alert on
   `hours_since_last_completion`, NOT kill count/streak — fmv-recalc: 38-kill streak, healthy."*
   **8 consecutive kills against a documented 64–73% base rate is P ≈ 0.7⁸ ≈ 6% — unremarkable.**
   The streak is not the finding and must not be quoted as one.
2. ⛔ **It is not "the pipeline is broken".** `fmv-recalc` was **re-characterised 2026-08-17 as
   wasteful, NOT broken**, and it still wrote **25,515 rows in 24 h**. The 59.6% kill rate measured
   here sits inside the documented 64–73% band. **Nothing here contradicts that characterisation.**

## ⭐ What IS worth a row, and it is one specific thing

**The band cleared and it kept killing.** Today's daytime IO band was exceptionally severe
(`io_wait 40 / active 41 of 51` at 18:06Z, ~4–5× the previous day). Band collateral would be the
obvious explanation — **except the band was measured back to `io_wait 0 / active 1 of 42` by ~19:16Z
and `1 / 2 of 42` at 20:04Z, and there have still been ZERO terminal rows since 18:48Z.**

👉 **So "it is just the band" is not sufficient for the last ~70 minutes of it.** That is the only
claim this filing makes.

⚠ **And the two arms are measuring different things — do not conflate them.** `hours_since_last
completion` is **1.63 h**; `fmv_sweep_wedge_hours` is **4.30 h**, because it counts time since the
cursor last *ADVANCED*, not since a run last finished. **A run can complete and advance nothing.**
The gap between 1.63 and 4.30 is itself the signal: runs were completing between 16:10Z and 18:48Z
**without moving the cursor.**

## ⛔ NOT established

- **Why it is killing now.** No route-level diagnosis was attempted; the band explanation is
  *insufficient*, not *excluded* (a spell can leave a cold pool behind it).
- **Whether the catalogue is actually going stale.** `*_fmv_stale_hours` arms are all green — but the
  wedge arm's own text says that family **structurally cannot see a sweep outage**, because other
  writers (cold-tail, thin-sales-guard, ask_only) keep touching `computed_at`. **So green there is not
  evidence of health, and I am not treating it as either direction.**
- **Whether 4.30 h is abnormal.** The arm's calibration window (which INCLUDES the 2026-08-05
  incident) records gap p50 0.20 h, p95 0.55 h, **max 6.00 h**. **4.30 h is a genuine breach and still
  below the historical max** — elevated, not unprecedented.
- ⚠ **n is one afternoon.** A 90-minute completion gap on a pipeline that completes ~59×/24 h
  (~1 per 24 min) is roughly 4× its mean interval. **That classifies; it does not rate.**

---

## 🚨 CORRECTED 20:3xZ — I HAD THE MECHANISM WRONG, AND THE REAL ONE IS SHARPER AND WORSE

**Everything above is a correct set of readings and a WRONG diagnosis. Kept, not rewritten, because the
correction is the useful part.**

⛔ **It is NOT being killed.** The runs COMPLETE and log themselves `ok:false`. Every terminal row since
17:57Z reads:

```
ok=false  rows_written=0
extra = {"stage":"step1b_refetch_empty","algo_version":"1.7.0","sales_fetch_errors":1}
```

⛔ **And my first instinct — the dead Top Shot legacy endpoint, which is salient today — is WRONG.**
The "sales fetch" is **a DATABASE query**, not an HTTP call. Vercel logs give the literal error:

```
[FMV-RECALC] Sales fetch error for edition slice 0-500 range 0:
    canceling statement due to statement timeout
[FMV-RECALC] Edition page returned 500 ids but no in-window sales survived re-fetch — skipping
```

⭐⭐ **THE CHANGE POINT IS ~17:56Z AND IT IS VISIBLE IN THE RANGE OFFSET.**

| runs | error at | what the run still achieved |
|---|---|---|
| 17:08Z, 17:15Z | `range 13000`, `range 16000` | fetched 13–16k sales, **processed ~1,460 editions**, widened 129–616 thin editions |
| **17:56Z onward** | **`range 0`** | **nothing — the FIRST chunk times out, `salesPage` is empty, the page is skipped** |

**So this is not a degradation, it is a step change: the first 1,000-row page of the sales re-fetch went
from succeeding to exceeding the statement timeout.** Confirmed still failing at 20:28Z, **on an instance
measured `io_wait 0–4`** — so ⛔ **the "saturation-class" label the code itself applies to this path does
NOT fit the current occurrence.**

⭐ **WHY THE CURSOR NEVER MOVES — it is BY CONSTRUCTION, not a wedge in the usual sense.** That branch logs
`p_cursor_before: String(offset)` and **`p_cursor_after: String(offset)`** — deliberately identical. So
every one of these runs is, to `fmv_sweep_wedge_hours`, a completed run that advanced nothing. **The arm is
behaving exactly as designed and is the only instrument that can see this**, which is what its own
description claims and is now demonstrated.

🚨 **AND `sales_fetch_errors: 1` IS NOT "one of many" — it is the WHOLE PAGE.** The route's own comment
says so: `IN_CHUNK` equals `DEFAULT_LIMIT` (both **500**), so a full page is exactly ONE chunk, and a single
failed chunk empties `salesPage`, skips the page and pins the cursor. **The same code comment records this
mechanism taking the sweep dark for 12.4 h on 2026-08-16 (14 of 17 consecutive runs).** ⭐ **So this is a
RECURRENCE of a documented failure mode, with a new and sharper signature — `range 0` rather than a
mid-page offset.**

## ⛔ What I could NOT establish, and one probe I refuse to quote

The failing statement is:

```sql
SELECT edition_id, collection_id, price_usd, sold_at, serial_number FROM sales
 WHERE sold_at >= <30d> AND price_usd > 0 AND collection_id <> <pinnacle>
   AND edition_id IN (<500 literal uuids>)
 ORDER BY id ASC LIMIT 1000 OFFSET 0
```

⚠ **I ran an `EXPLAIN` of that shape and it came back CHEAP (cost 15,409, Nested Loop, partition pruning
working, `Subplans Removed: 6`) — and I am NOT quoting it as evidence.** I substituted
`edition_id IN (SELECT id FROM editions LIMIT 500)` for the literal 500-UUID list PostgREST actually sends,
and **this repo has a standing, paid-for finding that this exact substitution changes the plan** (*literal
`IN` = 335 buffers; JOIN/subquery = 1.05M*), plus a second that a parameterised call does not plan like
inline text. **A cheap plan from the wrong shape is not evidence that production's shape is cheap.**

👉 **The faithful measurement is to `EXPLAIN (ANALYZE, BUFFERS)` this statement with a REAL 500-UUID literal
list, in a quiet window.** ⛔ Until then, **why the first page crossed the timeout at ~17:56Z is UNKNOWN** —
I have the symptom, the exact error and the change point, and no cause.

## 👉 Falsifier, cheap and dated

**Re-read `fmv_sweep_wedge_hours` and `max(started_at) WHERE pipeline='fmv-recalc'` on the next
monitor tick.**
- **Cursor advances and a terminal row appears ⇒ this was a long tail of the 08-29 band; close it.**
- **Still zero terminal rows several hours into a quiet instance ⇒ it is NOT the band, and the
  route-level kill cause becomes worth chasing** — at which point the relevant prior is the
  documented `after()`-kill class (heartbeat present, terminal row absent, `try/catch` cannot catch a
  `maxDuration` kill), and `npm run pipelines:kills` classifies it rather than re-deriving by hand.

⛔ **Do NOT raise `max_duration_s` on this in response to the arm.** The documented characterisation
is that the job is *wasteful*, so a longer budget buys a longer failure; and the 08-27 finding stands
that a function's declared timeout is inert on the pg_cron path anyway.
