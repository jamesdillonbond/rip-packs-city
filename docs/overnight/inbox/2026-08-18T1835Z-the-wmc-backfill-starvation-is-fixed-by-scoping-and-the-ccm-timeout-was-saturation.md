# The wmc backfill converts again (0 → 1,000 a tick), and the cross-collection mat timeout was saturation, not growth

**Filed 2026-08-18 11:35 PT (18:35Z), by Claude Code (interactive). Two open items closed on measurement; one hypothesis of mine refuted in the same pass.**

## 1. SHIPPED — `rpc-backfill-wmc-fmv-confidence` (jobid 302) now scopes each tick to one collection

The 17:25Z filing left this open with three options, cheapest first. **Option 1 shipped**: the cron
passes a rotating `p_collection_id` instead of `NULL`. No function change, no join-logic change.

Command now (jobid preserved — altered in place, never unscheduled):

    SELECT public.backfill_wmc_fmv_confidence(
      (ARRAY['95f28a17-…','dee28451-…','9b4824a8-…','06248cc4-…']::uuid[])
      [1 + ((EXTRACT(MINUTE FROM now())::int / 5) % 4)], 1000);

The schedule is `2-59/5`, so `minute/5 % 4` cycles evenly: Top Shot → All Day → UFC → Golazos, each
getting a tick every 20 minutes.

**Measured both directions, same instrument, minutes apart in the same quiet window:**

| call | converted |
|---|---|
| `backfill_wmc_fmv_confidence(NULL, 1000)` — what the cron ran until today | **0** |
| `backfill_wmc_fmv_confidence('95f28a17-…', 1000)` — Top Shot scoped | **1000** |

**Verified in production on the OUTCOME table, not the job's self-report:** the first rotated tick
(18:27Z, All Day's slot) took All Day's NULL-confidence population from **33,861 → 32,861** — exactly
1,000.

**Why `NULL` converted nothing.** The backlog in index order `(collection_id, edition_key)`:

| collection | NULL-confidence rows | sorts |
|---|---|---|
| golazos | 6 | first |
| **disney_pinnacle** | **53,035** | **second — the head block** |
| nba_top_shot | 452,789 | third |
| ufc_strike | 499 | fourth |
| nfl_all_day | 33,861 | last |

`LIMIT p_limit` sits **inside the `targets` CTE, above the join**, so a tick only ever examines the
first 1,000 rows of that order. Those are Pinnacle rows, the join `e.external_id = wmc.edition_key`
is the single-key Pinnacle join **concierge rule 2 forbids**, so they resolve nothing, stay NULL, and
**remain at the head forever**. 452,789 Top Shot rows sat behind 53,035 rows that can never move.
Pinnacle is deliberately excluded from the rotation: it is uncoverable by this join, and excluding it
is the entire fix. The real Pinnacle fix is still the triple / `render_id` re-key.

⚠ **This IS an IO-budget change, which `cron-and-schedulers.md` explicitly demands be treated as one**
(302 is a former #1 disk reader). Measured rather than assumed: a scoped 1,000-row tick is
**14,056 ms** under load, against a 5-minute slot. The job now does the work it was always designed to
do — the volume per tick is unchanged at 1,000; only the productivity changed.

⚠ **Do not read the recorded tick duration as work.** The 18:27Z tick recorded **370.3 s** while its
backend was observed `idle`/`ClientRead` at 245 s and its rows were already committed and visible to
another session. Most of that number is pg_cron's reaping lag, not compute — the timed call above is
the honest figure.

**Revert:** `SELECT cron.alter_job(302, command := 'SELECT public.backfill_wmc_fmv_confidence(NULL, 1000);');`

## 2. CLOSED on measurement — the cross-collection mats' 08-18 timeout was SATURATION, and my growth hypothesis is REFUTED

The 15:06Z filing called both `rpc-ccm-step1`/`step2` failures a saturation symptom and said to
re-measure in a quiet window. I initially read the history as *growth* instead — step1's successful
runs went 161 s (08-16) → 349.7 s (08-17) → killed at 600 s (08-18), and it had **also** failed on
08-15, so it was 2-of-4, not a novel failure. **That inference was wrong.**

Measured in a quiet window (4 of 37 backends in IO wait) with a **rolled-back probe** — the exact
aggregate, `RAISE EXCEPTION` carrying the result so nothing was written and no lock was taken:

    PROBE_RESULT cohort=193 elapsed_ms=104924

**105 s against a 600 s ceiling.** The work fits with 6× headroom, so the 08-18 kill was IO pressure,
exactly as filed. No fix needed; it self-heals at the next clean 04:10Z tick. The 15:06Z disposition
stands — **escalate only if it fails a second consecutive day.**

⚠ **A manual catch-up was deliberately NOT run.** `refresh_cross_collection_cohort_step1` opens with
`TRUNCATE`, which takes ACCESS EXCLUSIVE on a table the public `/insights/cross-collection` board
reads — a multi-minute daytime block on a board serving ~1 WAU, to buy ~10 hours of freshness on a
mat that refreshes itself tonight. Not worth the IO on an instance already running four heavy jobs.
The mat stays ~38 h stale until 04:10Z, stated rather than quietly fixed.

⚠ **Fresh instance of the inert-proconfig rule:** `refresh_cross_collection_cohort_step1` declares
`statement_timeout=180s` in its `proconfig` and **ran 600.2 s** before being cancelled. The binding
value was `cron_heavy`'s role-level `statement_timeout=600s`. The function-level declaration did
nothing, as CLAUDE.md records.

## 3. Two method notes worth keeping

- ⚠ **`cron.alter_job(id, schedule := …)` did NOT take effect here.** A job altered to `'28 * * * *'`
  at 18:25:36Z never fired at 18:28. A job created with `cron.schedule` at 18:19Z fired at 18:22Z on
  time. Same session, same minute-granularity. **Create a fresh job rather than re-aiming an existing
  one** when the firing time matters. (Altering `command :=` alone DID take effect — the 18:27 tick
  ran the new command.)
- ⚠ **A five-minute gap with zero job starts is not a stalled scheduler.** Between 18:28Z and 18:32Z
  nothing started, while three jobs sat `running` with idle backends — which reads exactly like a
  wedged pg_cron launcher. It was not: `max_running_jobs` is 32 with 4 running, no locks on `cron.*`,
  zero idle-in-transaction, and the launcher resumed on its own at 18:33:10Z. **I called it a stall
  before checking the control.** The tell that it was IO, not a wedge: the concurrent heavy jobs
  (`remap_misattributed_topshot_sales` 577 s, `refresh_atlas_pack_ev` 457 s,
  `refresh_wmc_fmv_changed` 337 s) were all in `IO/DataFileRead`.

## State left behind — verified clean

- jobid 302: active, rotation command live, **jobid preserved**.
- `rpc-oneshot-%` jobs: **0** (probe 345 and catch-up 346 both unscheduled).
- No role-level `statement_timeout` was ever set, so none needed reverting.
- Backlog now: Top Shot 450,789 · Pinnacle 53,035 (untouched by design) · All Day 32,861 · UFC 499 ·
  Golazos 6. At 72 ticks/collection/day the Top Shot tail drains in ~6 days.
