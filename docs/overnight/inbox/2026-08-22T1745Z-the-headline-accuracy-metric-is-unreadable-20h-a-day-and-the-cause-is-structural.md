# The roadmap's #1 metric is unreadable ~20 hours a day, and the cause is structural — but my candidate fix did NOT validate

**Filed 2026-08-22 ~10:45 PT (17:45Z), Claude Code interactive. PLAN evidence only — ⚠ NO timing or
buffer measurement survived, and §4 says why that matters. NOTHING SHIPPED, no migration written.**

---

## 1. Why this is the mission item, not a performance nit

`docs/strategy/roadmap-2026-08-03.md`: **accuracy is the GATE, not a phase**, and the headline metric is
**the share of prices at HIGH/MEDIUM confidence**. The sentinel's `FMV Confidence (canonical TS)` arm is
that meter.

**It failed on BOTH sentinel runs today** — 14:49Z and 15:47Z — with
`RPC error (canceling statement due to statement timeout)`. It sits inside the measured **01:00–19:00Z**
degraded band, so **the number the roadmap is steered by can only be read for about four hours a day.**
You cannot manage what you cannot measure, and this is the thing being managed.

## 2. The structural cause, from the PLAN

`sentinel_fmv_confidence_canonical_ts_split()` is:

```sql
FROM public.fmv_current fc
JOIN public.editions e ON e.id = fc.edition_id
WHERE e.collection_id = '95f2…'  AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
GROUP BY 1, 2;
```

`fmv_current` is `SELECT DISTINCT ON (edition_id) … FROM fmv_snapshots ORDER BY edition_id, computed_at
DESC` — **latest-per-edition over the whole partitioned table, with no predicate of its own.**

`EXPLAIN` (no ANALYZE — see §4):

```
GroupAggregate  (cost=78437.64..78575.74 rows=5022)
  -> Hash Join  (cost=4263.03..78128.93 rows=5022)
       -> Unique  (cost=0.70..73661.91 rows=13230)
            -> Merge Append  (cost=0.70..70660.67 rows=1200497)   ← ALL 1.2M ROWS
       -> Index Scan on editions  (rows=10343)
```

🚨 **The `editions` predicate cannot push through the `DISTINCT ON`, so the plan materialises the latest
row for EVERY edition in the estate — 1,200,497 snapshot rows walked — before the hash join narrows to
~5,022.** ~90 % of the estimated cost is that walk.

⚠ **This repo has already recorded this exact behaviour for a different caller**:
`inbox/2026-08-16T1829Z-fmv-current-does-not-push-down-through-distinct-on.md` measured
`compute_pack_ev_per_edition_weighted` at ~3,100× (335 vs 1,046,192 buffers), and CLAUDE.md's remedy is
*"fix the CALLERS via a lateral accessor"* — never `CREATE OR REPLACE VIEW fmv_current`, which resets
`security_invoker`.

## 3. The candidate, and its plan

Scope to the canonical TS editions first, then seek the latest snapshot per edition:

```sql
WITH ed AS MATERIALIZED (
  SELECT id, external_id FROM public.editions
  WHERE collection_id = '95f2…' AND external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
)
SELECT CASE WHEN ed.external_id LIKE '%::%' THEN 'parallel' ELSE 'base' END,
       fc.confidence::text, count(*)::bigint
FROM ed
JOIN LATERAL (
  SELECT s.confidence FROM public.fmv_snapshots s
  WHERE s.edition_id = ed.id ORDER BY s.computed_at DESC LIMIT 1
) fc ON true
GROUP BY 1, 2;
```

Plans at **cost 24,010 vs 78,576**, as a Nested Loop of ~10,343 index seeks against the per-partition
`fmv_snapshots_*_edition_id_computed_at_idx`. **It never walks the 1.2M rows.**

## 4. 🚨 WHY THIS IS NOT A RECOMMENDATION YET — the candidate ALSO timed out

**I ran the candidate once with `EXPLAIN (ANALYZE, BUFFERS)` and it hit the Supabase MCP 60 s cap.**

⚠ **So the 3.3× cost estimate is NOT validated, and I explicitly do not claim the rewrite is faster.** A
planner cost is an estimate; this repo's own rule is that a plausible mechanism is not a measurement.
The honest reading of one abandoned execution is: **unmeasured.**

⚠ **And the conditions make even that uninterpretable.** Positive control taken at the time: **16 of 27**
non-idle sessions in IO wait, later **10 of 10**, with an `autovacuum: VACUUM wallet_moments_cache`
running 536 s. During a saturation spell **no timing is interpretable and only buffers compare** — which
is exactly the number I failed to obtain.

⚠ **I also added load to the spell I was measuring, and cleaned up after myself.** CLAUDE.md records
that the MCP cap abandons the RESULT, not the query. I checked: mine was still running at 92 s (pid
3966238, `mgmt-api`), moved to cancel it, and it had already ended — verified **0 `mgmt-api` sessions
active** afterwards. **I did not retry the shape**, because retrying stacks copies onto the saturation.

## 5. ✅ ARMED — the measurement is scheduled, not left as a wish

A fresh-session routine (`trig_01H3p6o5iB7yyjLVzrbbviaA`) fires **2026-08-22 23:10Z** — hour 23 is the
quietest measured (3,683 busy-s vs hour 12's 39,098) and it is clear of the 20:15Z and 21:15Z applies.
⚠ **It is a MEASURE-ONLY task: it writes no migration and ships nothing.** ⚠ **And it opens with a
capability check** — `create_trigger` warned it stores no MCP connectors, so the fired session may have
no Supabase tools at all; step 0 tells it to report and stop rather than improvise. A runbook that
silently cannot execute is the same defect class as everything else in this filing.

Its runbook, in order — and every gate is a STOP, not a warning:



1. **Hard gate on the hour, then a POSITIVE CONTROL on `pg_stat_activity`** — if most active sessions
   are in IO wait the window is not quiet, and it must reschedule rather than collect numbers nobody can
   read. Then measure **warm-vs-warm, comparing BUFFERS not milliseconds** (each form run twice, second
   run used). Hour 23Z is
   the quietest measured (3,683 busy-s vs hour 12's 39,098). A cold candidate against a warm incumbent
   has already read as *5.6× slower* in this repo and nearly killed a correct rewrite.
2. ⚠ **Check the TIE case before claiming equivalence.** `DISTINCT ON (edition_id) ORDER BY edition_id,
   computed_at DESC` and `ORDER BY computed_at DESC LIMIT 1` both break ties arbitrarily. If any edition
   has two snapshots at the **same `computed_at` with different `confidence`**, the two forms may
   disagree — and this arm's whole output is a confidence tally. Count those first; if any exist, the
   lateral needs the same secondary ordering the view would effectively use.
3. **Prove equivalence with `EXCEPT` in BOTH directions** on the full predicate, not a sample.
4. Only then write the migration. It is a `CREATE OR REPLACE FUNCTION` on a **sentinel measurement**
   function — it reads FMV, it does not produce it, so it changes no price — but `apply_migration` still
   costs a ~10–20 s `PGRST002` burst and belongs in the quiet window.

## 6. What this does NOT say

It does not say the rewrite is the fix — see §4. It does not say the arm's timeout is *only* this query;
the arm could also be re-scoped or precomputed, and a nightly materialised tally would make the metric
readable **all** day rather than merely cheaper to compute in-band. **That alternative was not costed
and may well be the better answer** — a metric steered by a roadmap arguably should not be recomputed
from 1.2M rows on every sentinel tick at all.

---

## 7. ✅ DECISION 2026-08-22 — the destination is a NIGHTLY MATERIALISED TALLY

Decided on architecture. **It does not wait on §5's measurement, and it does not make that measurement
moot** — the two are complementary, which is the part that is easy to get backwards:

1. **The lateral rewrite is not an ALTERNATIVE to the tally; it is the tally's WRITER.** A nightly tally
   still has to compute the split once. The cheap query is what should compute it. So §5's measurement
   keeps its full value — only its question changes, from *"should the sentinel arm run this in-band?"*
   to *"is this the right query for the nightly writer?"*. The tie check (§5 step 2) matters **more**
   under this decision, not less: a tally is written once and then read all day, so a tie-breaking
   disagreement would be frozen into the number rather than re-rolled each tick.
2. **The tally fixes the stated defect; the rewrite only lowers its probability.** The defect is
   *unreadable ~20 h a day*. A 3.3× cheaper query still runs in-band, still inside the 01:00–19:00Z
   band, and can still be killed in a saturation spell — it reduces the odds without removing the
   dependency on disk-IO conditions. A tally read is a handful of rows from a small table and is
   readable at any hour, including during a spell.
3. **A GATE metric needs a SERIES, and this is the larger of the two defects.** This repo's own rule is
   that a directional claim needs a distribution, not a snapshot. The arm today can only answer *"what
   is the share right now"*; the roadmap's actual question is *"is accuracy improving"*, which it cannot
   answer at all. A dated tally table answers both, and the in-band rewrite does not touch this.
4. **Cost falls and becomes bounded** — one computation per night instead of one per sentinel tick.

⚠ **The honesty canon applies to the NEW design, and differently.** Reading a stored tally introduces a
failure mode the in-band query does not have: **a stale row that still renders as a current number.** The
arm must therefore report the tally's `computed_at` and warn when it is older than roughly one writer
interval — and must never present a stale share as today's. The three states are unchanged (read failed
· read ok + genuinely empty · read ok + **stale**), and "stale" is the new third state. A tally that
silently ages is strictly worse than a query that loudly times out, because a timeout is falsifiable.

⚠ **What this decision does NOT authorise.** Nothing has shipped: no table, no writer, no migration, and
the sentinel arm still calls the RPC. §4's finding stands — the rewrite remains **unmeasured** and must
not be adopted on its planner cost. When the writer is scheduled, pick a minute in the quiet window that
does **not** collide with the 23:35Z slot proposed for pg_cron jobid 70 (known-issues item 19).

✅ **Shipped alongside this decision (2026-08-22):** the arm's `else if (data)` had no `else`, so a
no-error/no-payload read pushed **nothing** and the headline accuracy check **disappeared from the
sentinel report** rather than reporting itself unreadable — the unfalsifiable-alert class, on the one
metric the roadmap is steered by. Fixed in `app/api/sentinel/route.ts` with an explicit third-state
branch that claims no percentage, pinned by
`__tests__/api-sentinel-branches.test.ts` → *"keeps the confidence arm present, and claims no percentage,
when the RPC returns no payload"*. The test asserts the **absence of a percentage**, not the presence of
an error string, so it cannot be satisfied by a version that also publishes a fabricated `0%`; negative
control run against the pre-fix route showed exactly that one test red.

