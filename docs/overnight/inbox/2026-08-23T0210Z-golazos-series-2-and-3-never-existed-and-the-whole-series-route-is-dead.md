# Golazos Series 2 and 3 never existed on chain — and the series route, dead on every collection when I started, now returns 200 on all 26 URLs

**Filed 2026-08-22 (PT) 22:49 by Claude (Cowork, cloud), with Chrome + Flow mainnet egress.**
⚠ The filename carries the UTC stamp (`2026-08-23T0210Z`) as this directory does; the PT date is the 22nd. Timestamp read from the DB, not the sandbox clock.
Closes [the 08-22 filing](2026-08-23T0020Z-golazos-collection-series-claims-two-seasons-that-no-instrument-can-see.md).

⚠ **This document was rewritten twice as I got things wrong. Both corrections are kept in
place rather than edited out — §3 and §4 are the useful part of the filing.**

---

## 1. Series 2 / Series 3 — settled from the contract, rows deleted

Flow mainnet `/v1/scripts` against the Golazos contract at **`0x87ca73a41bb50ad5`**:

| on-chain field | value | what it settles |
|---|---|---|
| `Golazos.nextSeriesID` | **2** | exactly ONE series ever created — `{id 1, "Series 1", active}` |
| `Golazos.nextEditionID` | **576** | 575 editions ever minted, the exact size of our catalogue |
| `Golazos.totalSupply` | **1,919,761** | matches `get_series_detail(...).total_circulation` exactly |

Three instruments outside our pipelines agree: `laligagolazos.com` serves `/editions/575` (200)
and 500s from 576 up, with marketplace facets topping out at season **2022-2023** and no Series
facet at all (footer still © 2023); `dapper.market/laliga/edition/600` is "Edition not found"
while 541 renders; our own `editions` holds ids **1..575 with zero gaps**.

⚠ The prior filing's "second contract" hypothesis is **refuted**, not merely unsupported — a
second contract would still surface on the vendor's own front-end.

**Applied:** `audit_20260823_drop_phantom_golazos_series_2_3`. Pre-flight: nothing FK-references
`collection_series`, and no Golazos edition carries `series` 2 or 3.

```sql
-- REVERT
INSERT INTO collection_series (id, collection_id, series_number, display_label, season) VALUES
  (29,'06248cc4-b85f-47cd-af67-1855d14acd75',2,'Series 2','2023-24'),
  (30,'06248cc4-b85f-47cd-af67-1855d14acd75',3,'Series 3','2024-25');
```

## 2. The state I found the series route in

Every `/[collection]/series/[slug]` page was returning **HTTP 500** with
`canceling statement due to statement timeout` (SQLSTATE **57014**), logged from both
`generateMetadata` and the page. R19 in the page source already counted **259 occurrences across
38 users in 7 days**, and all 26 of those URLs are submitted to Google by
`lib/sitemap-data.ts:591-598`.

`get_series_detail` cost, `EXPLAIN (ANALYZE)` — one `LEFT JOIN LATERAL` over `fmv_snapshots`
**per edition**:

| series | editions | before |
|---|---|---|
| NFL All Day `series-4` | 54 | 10 ms |
| Golazos `series-1` | 575 | 1,573 ms warm / 4,610 ms cold |
| Top Shot `series-4` | 3,600 | 21,229 ms warm / 43,750 ms cold |

⛔ **First correction.** I wrote "the 8 s ceiling never fires — the guard rail is decorative",
inferred from a 21–44 s completion against a function declaring `SET statement_timeout TO '8s'`.
That is [[function-proconfig-statement-timeout-is-inert]] **case (b)** (psql/pg_cron). Production
reaches it as a **PostgREST `rpc/` entry point** — **case (a), where it binds and fires**, which
is exactly what the 57014 in the logs says. Memory recorded that correction on 2026-08-17 and I
re-derived the wrong half before reading it.

## 3. ⛔ Second correction, and the actual defect: the rollup already existed

Before finding this I designed, built, verified and populated a `series_stats_rollup` table plus
a refresh function. Then I listed `cron.job` and found:

> jobid **357** `rpc-series-detail-rollup` — `59 * * * *`, `cron_heavy`,
> `SELECT public.refresh_series_detail_rollup(240);`

**`series_detail_rollup` already existed, complete (26 rows, all five collections including
Pinnacle), fresh (21 minutes old when I found it), and correct** — its numbers matched the live
computation exactly. `get_series_detail` simply never read it.

👉 **The defect was never a missing rollup. It was a rollup with no reader.** A precomputed table
nobody queries is indistinguishable, from the outside, from a table that does not exist — and
the second-order cost is that the next person builds it again. I did. **`cron.job` and
`information_schema` are part of "grep first", not just the repo.**

My duplicate was dropped in `audit_20260823_drop_duplicate_series_stats_rollup`, including the
one `pipeline_runs` row it wrote, so no retired pipeline name can read as "stopped reporting".

## 4. ⛔ Third correction: RETRACTING the "permanent spinner" finding

Earlier drafts of this filing claimed a second, distinct failure mode: pages whose server render
succeeded but whose Suspense boundary never completed, leaving **"SCANNING THE MARKETPLACE…"**
on screen forever with the full page stranded in `<div hidden id="S:0">`. I called it
route-specific on the strength of one control — `/laliga-golazos/edition/541`, which had
relocated its `S:0` normally earlier in the same session.

**That control does not hold. Re-run at the end of the session, the edition page strands its
`S:0` too** — same browser, same session, a page whose CTA I had watched render at 217×47.

And the served HTML is complete. Fetched with a Googlebot UA from outside the browser entirely:

| url | status | bytes | edition links | JSON-LD | `$RC` script |
|---|---|---|---|---|---|
| `/nba-top-shot/series/series-7` | 200 | 253,522 | 11 | `numberOfItems: 25` | `$RC("B:0","S:0")` present |
| `/laliga-golazos/series/series-1` | 200 | 227,914 | 25 | `numberOfItems: 25` | `$RC("B:0","S:0")` present |

The server sends the content **and** the script that swaps it in. So whatever I was watching is
a condition of this browser session — the likeliest candidate being that this box is
**logged in as Trevor** and every page load preloads **15,108 owned moments**
([[chrome-mcp-live-qa-gotchas]] already records the logged-in caveat) — not something an
anonymous visitor or a crawler hits. **Not a site bug. Withdrawn.**

⚠ The lesson is the cheap one: **a control that passes once is not a control.** Re-run it at the
end, against the same claim, or it is just an anecdote that happened to agree with you.

## 5. What shipped, and the proof

| migration | what |
|---|---|
| `audit_20260823_drop_phantom_golazos_series_2_3` | deletes the two phantom Golazos series |
| `audit_20260823_get_series_detail_reads_existing_series_detail_rollup` | `get_series_detail` reads the rollup; each branch keeps its original live computation as the fallback for a series with no row, so a new series is slow-but-correct rather than fast-and-wrong |
| `audit_20260823_drop_duplicate_series_stats_rollup` | removes my duplicate |
| `audit_20260823_get_series_editions_project_after_limit` | projects **after** the `LIMIT`, so `entity_rep_nft_id()` runs 100× instead of 4,895×, plus a partition-pruning predicate |
| `audit_20260823_series_detail_rollup_enable_rls` | pre-existing `check_public_security_invariants()` violation, now clean |
| `audit_20260823_series_detail_rollup_duration_ms_never_recorded` | an instrument that could never fire |

**Before / after, Top Shot `series-7` — 4,895 editions, the heaviest series we have:**

| rpc | before | after |
|---|---|---|
| `get_series_detail` | 21,229 ms, 23k buffers | **37 ms, 523 buffers** |
| `get_series_editions` | 36,134 ms, 32,461 buffers, 4,026 reads | **219 ms, 18,198 buffers, 125 reads** |
| `get_series_rollups` | 104 ms | unchanged |

**Equivalence, checked before each swap rather than after:**

- `get_series_detail`: all six aggregates against the live lateral on **all 26 series**, three
  collections plus Pinnacle, 0–4,895 editions. Every column matched.
- `get_series_editions`: the new two-phase shape against the old single-CTE shape for Top Shot
  `series-7`, position by position — **100 rows, 0 mismatches** on `route_slug`, `fmv_usd` and
  `rep_nft_id`.

**End-to-end:** all **26/26** series URLs return **HTTP 200** with full payloads, 0.33–4.27 s,
fetched with a Googlebot UA from outside the browser. Zero non-200.

`check_public_security_invariants()` and `check_secdef_anon_execute_violations()` both return
`[]`.

## 6. What is NOT fixed

- **`get_series_editions` still costs ~3.5 ms per edition** in phase 1, because ordering the grid
  by FMV needs a latest-FMV read for every edition in the series. It fits inside 8 s today at
  4,895 editions; it will not at ~2× that. The durable fix is a per-edition latest-FMV rollup —
  the thing the `fmv_current` VIEW pretends to be — which would also serve other surfaces.
  **Deliberately not built here:** it is shared architecture, and I had already built one
  redundant rollup tonight without checking (§3).
- **`get_series_detail` now depends on cron jobid 357.** A missing row falls back correctly; a
  STALE row does not announce itself. The refresh currently takes **7.0 s** for all 5 collections
  against a 240 s budget, writes `pipeline_runs('series-detail-rollup')`, and now records
  per-collection `duration_ms`. Worth a staleness arm on the trust board.
- The source comment calling these *"transient RPC failure (statement timeout under contention)"*
  is still there and is still the wrong diagnosis. Route/.tsx edits cannot be pushed from Cowork.

---

## 7. The same defect was on the SET route, and it is 40× more traffic

Once the series shape was understood, `pg_stat_statements` (service_role, PostgREST entry
points) named the rest of the family:

| function | calls | mean_ms | max_ms |
|---|---|---|---|
| `get_edition_detail` | 65,144 | **122.4** | 7,783.9 |
| `get_player_detail` | 15,003 | 326.2 | 6,919.7 |
| **`get_set_editions`** | **6,237** | **1,820.5** | 7,990.3 |
| `get_series_detail` | 173 | 783.9 | 7,975.0 |
| `get_series_editions` | 149 | 961.6 | 6,995.7 |

**`get_set_editions` is the cleanest instance of the defect in the codebase.** Its `ORDER BY` is
`tier_rank, circulation_count, player_name` — three columns of `editions` and **nothing from
FMV** — so the `LIMIT` was always satisfiable from `editions` alone. It still computed the
per-edition `fmv_snapshots` lateral *and* `entity_rep_nft_id()` for every edition in the set
first. `/nba-top-shot/set/base-set` is 3,609 editions of work to render 100.

| | before | after |
|---|---|---|
| `get_set_editions('…','base-set',100,0)` | **10,676 ms**, 29,473 buffers, 3,501 reads | **31 ms**, 2,665 buffers, 20 reads |

Shipped as `audit_20260823_get_set_editions_project_after_limit`. **Equivalence proved by md5 of
the full jsonb output captured BEFORE the swap** — `base-set`, `holo-icon`, `throwdowns`, all
three byte-identical after.

At 6,237 calls × 1,820 ms this was roughly **11,350 seconds of DB time** in the pg_stat_statements
window. That is contention relief for the whole instance, not one page.

`get_player_editions` has the same shape but the largest player in the catalogue has **127**
editions, so the saving is ~27 wasted `entity_rep_nft_id()` calls. **Deliberately not changed** —
churn on a hot public RPC needs a reason bigger than that.

## 8. ⭐ The "45,000 ms class, unexplained since 2026-08-15" is NOT query time

The ledger's R19 entry records `rpc get_edition_detail timed out after 45000ms` **15,388 times
across 2,963 distinct users in 7 days**, and flags the 45 s class as an unexplained regression.

Two measurements settle half of it:

1. **`get_edition_detail` is cheap.** `EXPLAIN (ANALYZE)`: **428 ms** for Golazos edition 541 and
   **88 ms** for `49:1662` — the largest Top Shot edition in the catalogue at 239,882 circulation.
2. **The database never sees a 45 s execution of it.** Across **65,144** PostgREST calls its
   `max_exec_time` is **7,783.9 ms** — pinned just under the function's own 8 s `proconfig`
   ceiling, exactly the clustering signature that ceiling produces. Every sibling in the table
   above is capped the same way (6,919–7,990 ms).

👉 **45,000 ms is `DEFAULT_RPC_TIMEOUT_MS` in `lib/analytics/rpc-with-retry.ts`, and the DB cannot
produce it.** So the 45 s class is a **connection-acquire / transport stall**, not statement
execution — precisely what that file's own 2026-08-13 comment predicted ("a stuck
connection-acquire inside Supavisor parks the await indefinitely… the retry loop never runs,
because there is no error to retry"). The remaining question is what saturates the pool, not what
the query costs.

⚠ Which is why §7 matters more than its page count: removing ~11,350 s of DB time from the
busiest entity RPC is a direct lever on the thing that produces those stalls. **Whether it moves
the 45 s count is now a measurable prediction — check `get_edition_detail` 45 s throws over the
next 7 days against the 15,388 baseline.** If it does not move, the saturation source is
elsewhere and that is worth knowing too.

## 9. Verified after everything

- **26/26** series URLs → HTTP 200 (0.33–4.27 s).
- `/nba-top-shot/set/base-set`, `/set/metallic-gold-le`, `/set/holo-icon` → **200** (3.9–4.6 s).
- `/nba-top-shot/edition/49:1662` → 200 · `/nba-top-shot/player/lebron-james` → 200.
- `check_public_security_invariants()` → `[]` · `check_secdef_anon_execute_violations()` → `[]`.
- Every touched function: **one overload, SECURITY DEFINER intact, `postgres | service_role`
  only** (plus `cron_heavy` on the refresh, which needs it). No `CREATE OR REPLACE` re-grant.

---

## 10. ⛔⛔ TWO MORE CORRECTIONS, both found after Trevor pasted the ledger entry

### 10a. "A rollup with no reader" is wrong — I clobbered a concurrent session

`supabase_migrations.schema_migrations`, UTC:

| time | |
|---|---|
| 01:58 | I measure `get_series_detail` at 21 s and read its body — the per-edition lateral is genuinely there |
| 03:14 | `audit_20260823_series_detail_rollup` — **another session creates the table** |
| 03:16 | `audit_20260823_get_series_detail_reads_the_rollup` — **that session swaps the reader** |
| 03:21 | `audit_20260823_watchlist_series_detail_rollup` — staleness arm, 180 min, medium |
| 03:23 | jobid 357 scheduled |
| 05:16 | I build a duplicate rollup, never having re-read the function |
| 05:20 | I `CREATE OR REPLACE get_series_detail`, overwriting 03:16 |

So §3's "the rollup existed and the reader was never wired up" is false: it had been wired for
two hours. My diagnosis was right at 01:58 and stale by 03:16. ⚠ **A 21-minute-old rollup and a
21-month-old rollup look identical — freshness is not provenance, and `schema_migrations` was
one query away.**

The clobber silently dropped a 13th return key, `stats_computed_at`. Nothing in `app/ lib/
components/ __tests__/` reads it, so no surface broke, but the committed migration promised it
and production stopped delivering it. Restored; 13 keys and a non-null stamp verified on all 26
series. The one difference I kept on purpose is the live fallback for a series with no rollup
row — theirs returns NULLs, mine computes it.

Also: the staleness arm I listed as "still open" in §6 **already shipped at 03:21**.

### 10b. ⛔⛔ "26/26 return 200 with full payloads" was a quiet-window measurement

At 17:20 UTC the same day, `/nba-top-shot/series/series-7` was back to an empty grid
(`get_series_editions … STRUCTURAL — throwing`, `get_series_rollups … degrading to empty`).

| `get_series_editions`, TS series-7 | time | buffers | **reads** |
|---|---|---|---|
| 06:00 UTC quiet, warm | 219 ms | 24,739 | 125 |
| 17:20 UTC under load | **47,669 ms** | 24,739 | **2,926** |

**Buffers identical, reads 23×, time 217×.** The work was always read-bound and the warm reading
hid it. 👉 **On this instance a warm timing is not evidence. Quote reads.** I cited both
warm/cold memory entries in this very filing and then made the mistake anyway.

### 10c. What fixed it for real

**`edition_fmv_current`** — latest snapshot per edition, materialised: 27,075 rows (22,539 with
FMV), 9.4 MB, one ordered pass instead of 27,075 random probes. Rebuilt at the TOP of
`refresh_series_detail_rollup` (order is load-bearing) so it inherits jobid 357's existing
staleness arm.

⭐ **Ordering comes from the rollup; the displayed price is still read LIVE** for the ≤100 rows
that survive the LIMIT. No collector sees a stale price — only which rows appear can lag, on a
page already cached 600 s.

| | before | after |
|---|---|---|
| `get_series_editions` TS series-7 | 47,669 ms · 2,926 reads | **55 ms · 14 reads** |
| jobid 357 refresh | 99 s cold / 11 s warm | **76 s cold / 2 s warm** |

`get_series_rollups` reads the same table, so the per-set/per-player breakdown and the series
total now come from the **same FMV tick** — previously they could disagree. Both readers carry an
`EXISTS` guard so an unrefreshed rollup degrades to the honest slow path instead of silently
reordering the page.

**Verified under load:** 26/26 clean 200s with full payloads and zero "Couldn't load" markers at
~17:55 UTC. Equivalence md5s captured before every swap; `edition_fmv_current` checked against a
live per-edition read for all 575 Golazos editions (0 differences). Security invariants: 0 rows
and `[]`. No leftover one-off crons.

⚠ **Everything in §10c lives only in the DB.** For `get_series_detail` the repo's committed
version (`2bca41b4`) is now three revisions behind production.

---

## 11. ⛔⛔ I BROKE jobid 357, AND THE WAY I "VERIFIED" IT IS THE POINT

Seven minutes after folding `refresh_edition_fmv_current()` into
`refresh_series_detail_rollup`, the real **17:59 UTC tick failed at exactly 600 s** —
cron_heavy's ceiling — inside the full-population `DISTINCT ON` I had added.

| tick | result |
|---|---|
| 14:59 | succeeded, 351 s |
| 15:59 | succeeded, 177 s |
| 16:59 | succeeded, 49 s |
| **17:59** | **FAILED, 600 s** — `canceling statement due to statement timeout` in `WITH latest AS MATERIALIZED (SELECT DISTINCT ON (s.edition_id) …` |

**How I had "verified" it: two one-off runs, 76 s and 2 s — both starting seconds after a
previous run had warmed the same pages.** That is the warmest condition available, on a job whose
whole risk is being cold. §10b of this filing is me writing down "a warm timing is not evidence
on this instance", and I committed the same error inside the same hour, on a scheduled job, where
the cache state at 59 past the hour is precisely what I failed to sample.

👉 **A scheduled job is not verified by a manual run. It is verified by a tick it does not share
a cache with.** Nothing else counts.

Two independent faults, two fixes:

**1. The rebuild was O(whole table) every hour.** Now incremental off a watermark
(`max(computed_at)` in `edition_fmv_current`) minus a **2-hour safety lag**, because FMV backfills
write rows with older `computed_at` than the run that follows them and a bare `> watermark` would
skip those forever. Served by `idx_fmv_snapshots_2026_computed_at_desc`, so the scan is
proportional to what changed. The upsert also carries
`WHERE EXCLUDED.computed_at >= t.computed_at` so a late-arriving older snapshot cannot move a row
backwards. Full pass survives only for a cold start.

> **>600 s (failed) → 2.1 s, 321 rows.** Whole job end to end: **4.1 s**, `ok: true`, 0 skipped,
> down from 49–351 s even before my change.

⚠ Stated, not hidden: the incremental path cannot mark-and-sweep orphans. An edition whose
snapshots are deleted keeps a stale row until a full rebuild. `full_rebuild` in the return value
says which path ran.

**2. A new component was wired into a load-bearing job with no isolation.** The series rollup —
26 indexable pages depend on it — died alongside a table it does not need in order to run. The
`PERFORM` now sits in its own `BEGIN/EXCEPTION` block: if the FMV rebuild fails, the aggregates
still refresh from the previous hour's copy. ⚠ **And it is not silent** — the error goes into the
return value and `pipeline_runs.extra`, and the run is marked **`ok = false`**. Catching an
exception to keep pages served is fine; catching one to report success is the silent-degradation
class.

**Re-verified after the fix:** `edition_fmv_current` still matches a live per-edition read for all
**1,093** Golazos + UFC editions (0 differences on fmv/floor/confidence, 0 missing); the stored
series aggregates re-derive live for all three of those series; `series-7` and `golazos series-1`
serve 253 KB / 228 KB in ~0.6 s with 0 "Couldn't load" markers.

⚠ **Still unverified at the time of writing, deliberately flagged rather than claimed:** the real
**18:59 tick**. A check is scheduled for 19:04 UTC. If it fails again the answer is to take the
FMV rebuild off the critical path entirely and give it its own job — the coupling is the part I
got wrong, not just the cost.

---

## ✅ THE 18:59 TICK FALSIFIER IS READ 2026-08-25 ~20:15 PT (2026-08-26 03:15Z, Claude Code interactive) — the fix HELD, and the one failure exposes that §2's isolation cannot work

This filing closed on a named, unverified falsifier: *"the real 18:59 tick … If it fails again the answer is to take the FMV rebuild off the critical path entirely and give it its own job — the coupling is the part I got wrong."* **Three days of ticks now exist.**

### 1. The fix held, by a wide margin

`cron.job_run_details`, jobid **357** `rpc-series-detail-rollup` (`59 * * * *`, `cron_heavy`), 2026-08-23 03:59Z → 2026-08-26 02:59Z: **72 ticks, 71 succeeded, 1 failed.** Against the pre-fix state of *every* series page returning 500, that is the fix working. ✅ **The incremental-watermark rebuild is the durable half and it is doing its job.**

### 2. ⚠ But the one failure is the coupling the filing predicted, and §2's guard against it CANNOT FIRE

The failure is `57014 canceling statement due to statement timeout` at 600.0 s, and its context names **the protected line itself**:

```
PL/pgSQL function refresh_edition_fmv_current() line 8 at SQL statement
PL/pgSQL function refresh_series_detail_rollup(integer) line 16 at assignment
```

Line 16 is `v_fmv := public.refresh_edition_fmv_current();` — **inside** the `BEGIN … EXCEPTION WHEN OTHERS` block this filing added, described as *"Isolated so it cannot take the job down: a stale edition_fmv_current still produces a correct-shaped rollup, one tick behind."*

🚨 **`EXCEPTION WHEN OTHERS` does not catch `query_canceled`.** PostgreSQL excludes `QUERY_CANCELED` and `ASSERT_FAILURE` from `OTHERS`, and a `statement_timeout` raises exactly 57014. Re-verified on this instance 2026-08-26, both directions, on a scratch function dropped afterwards: `WHEN OTHERS` **escaped**; `WHEN query_canceled` **caught**. ⚠ **So the isolation protects against a logic error in the FMV rebuild — which has never happened — and not against the timeout, which is the only failure this job has ever had.**

⛔ **This was already known and is why it matters.** It was established **2026-08-15** (the trust-precompute 999-sentinel filing) — *eight days before* this isolation shipped. It was recorded in `trust-board-and-safety.md` as a trust-board fact, so an author working on series precompute had no reason to find it. **Now promoted to [`database.md`](../../reference/database.md) as the PL/pgSQL fact it actually is.**

### 3. ⛔ Do NOT fix it by widening the clause

`WHEN query_canceled OR OTHERS` was applied and reverted on 2026-08-15. The decisive measurement: **after a cancel is caught the timer is not re-armed**, so everything after the handler runs **unbounded**, holding a pooled connection on the instance whose saturation caused the timeout. **A bounded failure traded for an unbounded one.**

### 4. ➡ The remedy is the one this filing already named

**Take the FMV rebuild off the critical path and give it its own pg_cron entry.** Its own top-level statement means a fresh budget, no reach into the rollup loop, and `cron.job_run_details` naming it directly. ⚠ **Not shipped here** — jobid 357 is **`cron_heavy`-owned**, so it cannot be rescheduled from a session-reachable role, and splitting the function is a migration plus a new schedule. ⓘ **Severity is low and stated so the decision is proportionate:** 1 failure in 72, costing the 26 series pages one hour of staleness, on aggregates that refresh hourly.

### 5. What I did NOT establish

- ⛔ **Why a FULL rebuild ran at all.** The failing statement is the unbounded `DISTINCT ON (edition_id) FROM fmv_snapshots` full-pass, which this filing says *"survives only for a cold start"*. What made the watermark path fall back was not investigated.
- ⛔ **Whether the 1-in-72 rate is stable.** One failure is too few to separate a cold-start artifact from a recurring one.
