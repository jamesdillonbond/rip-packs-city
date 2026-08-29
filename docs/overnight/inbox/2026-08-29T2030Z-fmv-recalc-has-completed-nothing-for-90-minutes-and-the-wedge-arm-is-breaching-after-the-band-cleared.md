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

---

## ✅✅ CAUSE MEASURED 20:5xZ — the faithful plan, and the subquery probe WAS lying

I said the faithful measurement needed a **real 500-UUID literal list**, because a subquery plans
differently here. **Done — and the caution was justified.** The 500 ids came from calling the route's own
`fmv_recalc_edition_page(window_start, pinnacle_id, 500, 0)`, i.e. exactly the page production feeds into
step 1b. Run on an **idle** instance:

| | plan | time |
|---|---|---:|
| my earlier **subquery** probe | `Nested Loop` + per-partition Index Scans, cost 15,409 | (never ran to completion) |
| **the real literal `IN` list** | **`Bitmap Heap Scan on sales_2026`**, cost 12,707 | **48,268 ms** |

⭐⭐ **48.3 SECONDS ON AN IDLE INSTANCE, AGAINST `service_role`'s 30 s STATEMENT TIMEOUT. That is the
outage — the statement cannot finish inside its ceiling, so it is killed every single run.**

**The node detail:**

```
Bitmap Heap Scan on sales_2026  (actual time=8201.518..48232.770 rows=27025)
  Heap Blocks: exact=9471
  Buffers: shared hit=1147 read=9882 written=164
  -> Bitmap Index Scan on sales_2026_edition_id_sold_at_idx
       (actual time=8186.569..8186.570 rows=27080)
```

⭐ **8.2 s is the bitmap index scan (500 separate probes). The remaining ~40 s is HEAP FETCHING: 9,471
heap blocks, of which 9,882 buffer accesses are DISK READS against only 1,147 hits.**

🚨 **AND IT IS THE SAME DEFECT CLASS AS THE TWO I FIXED EARLIER TODAY.** `sales_2026_edition_id_sold_at_idx`
is keyed `(edition_id, sold_at)` — **exactly right for the predicate, and it carries none of the
projection.** The query selects `collection_id, price_usd, serial_number`, so **every one of the 27,025
matching rows must be visited in the heap.** Right index, missing payload, heap fetch per row — the third
instance today after jobid 211 and jobid 237.

⚠ **A SECOND, INDEPENDENT PROBLEM IN THE SAME STATEMENT, and an index does not fix it.** The query is
`ORDER BY id ASC … LIMIT 1000 OFFSET <from>`, and the plan is `Limit → Sort → Bitmap Heap Scan`. **It
materialises and sorts all 27,025 rows to return 1,000 — and then the NEXT page does it again.** At
~27 pages that is O(n) work per page for a full drain. **Even with a covering index this shape re-scans
per page**; keyset pagination on `(id)` would not.

## ⛔ Still NOT established — the honest boundary

**What changed at ~17:56Z is still unknown.** 48.3 s idle explains why it fails *now*, but not why the
same statement was reaching `range 13000`–`16000` a few hours earlier. Candidates, none tested: a plan
flip into the bitmap shape, buffer-pool eviction that never recovered (the `read=9882` vs `hit=1147` split
is a very cold cache), or the visibility map/heap growing past a threshold after the 10:20Z vacuum plus a
day of writes. ⚠ **Do not present the 48 s as "the regression" — it is the CURRENT cost. The step change
needs a before/after the timing of which I cannot reconstruct from retained data.**

## ⛔ Why I did NOT ship the obvious fix

The shape that worked twice today — add the payload to the covering index — points at
`sales_2026 (edition_id, sold_at) INCLUDE (collection_id, price_usd, serial_number)`. **I did not build
it, deliberately:**
- **`sales` is the hottest table on the platform** and is PARTITIONED; an index there is a materially
  bigger decision than `pack_rips`, with per-partition and write-amplification questions I have not sized.
- **It only fixes half.** The `ORDER BY id` + `OFFSET` pagination re-sorts the full match set per page, so
  a covering index makes each page cheaper without removing the O(n)-per-page shape.
- **The trigger is unknown** (above), and fixing the symptom without it risks masking a real regression.
- I have already shipped one index today; **a second, larger one on the hottest table at short notice is
  how a 5-hour outage becomes a longer one.**

👉 **The next step is a decision, not a diagnosis: size that covering index (or the keyset rewrite) against
`sales_2026`'s write path.** Everything needed to start is in this section.

## 🔎 CHASING THE 17:56Z TRIGGER — one hypothesis REFUTED, and a collision found instead

**Hypothesis tested: a stats refresh flipped the plan into the bitmap shape.** ⛔ **REFUTED.**
`pg_stat_user_tables` for `sales_2026`: `last_analyze` **2026-08-29 07:04:43Z**, `last_autoanalyze`
**2026-08-28 18:13:45Z**, `last_autovacuum` 2026-08-29 15:45:02Z. **Nothing at or near 17:56Z**, and the
only nearby event (an autovacuum at 15:45Z) would *improve* the heap, not degrade it. **The tidy
explanation is wrong and the trigger is still unidentified.**

🚨 **BUT `pg_stat_statements` turned up something that changes what anyone should DO next:**

```
CREATE INDEX CONCURRENTLY idx_sales_2026_fmv_recalc_window_v2
  ON public.sales_2026 USING btree (sold_at DESC) INCLUDE (edition_id, collection_id) WHERE …
    calls=1   mean_exec_time=195,824 ms   shared_blks_read=80,999
```

⭐⭐ **Another session has already ATTEMPTED an fmv-recalc index fix on this exact table — a 195-second
`CREATE INDEX CONCURRENTLY` — and the index DOES NOT EXIST.** Verified: `v2_exists = 0`, **0 invalid
indexes database-wide**, 0 `CREATE INDEX` currently running, 0 `tmp-*` cron jobs. **So the attempt left no
debris; it was dropped or rolled back cleanly.** `idx_sales_2026_fmv_recalc_window` (the v1, 60 MB) is
still present and valid.

⛔ **THIS UPGRADES "I chose not to ship" TO "SHIPPING WOULD NOW COLLIDE."** Building a covering index on
`sales_2026` while another session is actively iterating on one is exactly the concurrent-work hazard this
repo already records. **Do not ship one without coordinating.**

⚠ **AND A SUBSTANTIVE OBSERVATION ABOUT THAT ATTEMPT, offered rather than asserted: `v2` is keyed
`(sold_at DESC) INCLUDE (edition_id, collection_id)` — that is the shape STEP 1A needs (the edition-page
window scan). The failure is in STEP 1B**, whose predicate is `edition_id IN (…) AND sold_at >= …` and
whose projection is `collection_id, price_usd, serial_number`. **A `sold_at`-leading index does not serve
that**, so if `v2` was aimed at this outage it may not have fixed it — which would explain why it did not
survive. 👉 **The step-1b shape is `(edition_id, sold_at) INCLUDE (collection_id, price_usd,
serial_number)`.** ⚠ Inference from the two definitions, not from watching the build.

## ⏱ SEVERITY UPDATE 22:0xZ — this is now the WORST recorded stall, not an elevated one

**The wedge reads 5.92 h and is rising roughly an hour per hour.** The arm's own calibration — taken over a
72 h window that INCLUDED the 2026-08-05 incident — is gap p50 **0.20 h**, p95 **0.55 h**, max **6.00 h**.

⛔ **So the "a real breach, but below the arm's 6.00 h historical max" qualifier written above at 4.30 h is
now expired.** At 5.92 h this is level with the worst gap ever recorded for this arm and will pass it
within the hour. **Treat it as the worst observed sweep stall, not a bad afternoon.**

ⓘ Everything else is unchanged and previously filed: the two `public_board_*_count = 999` arms are the
known jobid-288 rotation oscillation (they clear on its next sweep), and `unmapped_resolution_backlog_max`
is **draining** (317 → 310). ✅ Security clean, **0 invalid indexes database-wide, 0 leftover `tmp-*` cron
jobs.**

## 🚨🚨 THIRD CORRECTION, 22:4xZ — THE OUTAGE HAS ENDED, AND MY "48.3 s ON AN IDLE INSTANCE" WAS WRONG

**Two things, and the second is a mistake in my own method.**

### 1. The 48.3 s was NOT an idle-instance cost — the same query now runs in 5.1 s

Re-ran the **identical** statement (same 500 literal ids, same shape):

| run | time | buffers |
|---|---:|---|
| ~20:50Z | **48,268 ms** | `hit=1147 read=9882` |
| ~22:1xZ | **5,062 ms** | `hit=920 read=10126` |

⭐⭐ **9.5× faster on essentially IDENTICAL work — the second run did MORE disk reads (10,126 vs 9,882).**
**So it is not the buffer cache and not query structure: the variable is IO SERVICE TIME.** Same lesson
this repo learned on the underpriced board earlier today — **load PRICES latency, it does not add it.**

⛔ **And the error is mine: I wrote "48.3 SECONDS ON AN IDLE INSTANCE" without checking the instance at
the moment of that measurement.** I had read `io_wait 0 / active 1 of 42` at **20:04Z** and then ran the
`EXPLAIN` at **~20:50Z**, 45 minutes later, never re-reading. **A stale positive control is not a control.**
The honest statement is: *the statement costs ~10k random reads, so it takes 5 s when IO is cheap and 48 s
when it is not, and the 30 s ceiling sits between those.*

### 2. Step 1b is PASSING again — the outage is over, and what is left is the documented state

Vercel logs for the **22:28Z and 22:35Z** runs contain **no `Sales fetch error … range 0`** at all. They
get through step 1b and proceed:

```
Wash-trade filter: removed suspicious clusters from 259 editions
90d catch-up: seeded 724 zero-30d Top Shot / 287 All Day editions
Processing 1511 distinct editions
90d window extension: widened 1073 thin editions (11880 sales)
thin-sales guard applied — thin=0 stale=59 …
… Vercel Runtime Timeout Error: Task timed out after 300 seconds
```

⭐ **So the runs now die at the 300 s LAMBDA cap, not at the 30 s statement timeout — which is exactly the
pre-existing, characterised `fmv-recalc` behaviour (*wasteful, NOT broken*, 64–73% wall-kills).** The
step-1b total block ran roughly **17:56Z → ~21:28Z** and has cleared on its own as IO pressure eased.

⚠ **The wedge is still rising (6.52 h) and that is NOT a contradiction:** a run killed at 300 s advances
the cursor no more than a run that fails at step 1b. **The arm cannot distinguish them, and it should
not — both mean the catalogue is not being repriced.**

ⓘ Many *other* statements in those same runs still log `canceling statement due to statement timeout`
(historical fallback, `edition_offers` ASK, All Day ASK, stale-freshness, the 90d extension). **Those
branches are non-fatal and the run survives them** — but it is a fair signal of how much of this route is
living on the edge of the 30 s ceiling.

### What this changes about the recommendation

⭐ **The covering index is still the right idea and is now BETTER motivated, not worse:** removing ~10k
random reads removes this statement's exposure to IO pressure entirely, which is precisely what took the
sweep down for 3.5 h. ⛔ **But it is NOT an emergency fix, the collision warning above still stands, and
nobody should ship it tonight on my say-so.**

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
