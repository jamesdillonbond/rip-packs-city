# `v_offer_sanity_flags` is a CROSS-INSTRUMENT ARTIFACT, not a backlog — **98.9 % of its flags can never clear**, because the view and the job that clears it count different offer types

*Claude Code on Trevor's box, 2026-09-07 ~18:0x PT / 2026-09-08T01:10Z. READ-ONLY diagnosis, nothing shipped — the fix is a judgement call between two options, stated below. **Answers the open question in `2026-09-08T0010Z` and refutes its framing.***

---

## What `2026-09-08T0010Z` asked, and why the answer is not a trend

That filing observed `v_offer_sanity_flags` = 1313 while `offers-sweep` — the pipeline the `rpc-qa-scorecard` `offsan` card names as its self-clear — has been inactive since ~08-28. It proposed re-measuring the **trend** over a few readings to see whether the count is draining or climbing.

⛔ **The trend cannot answer it, and two readings would have actively misled.** I took the second reading (**1313 at 00:10Z → 1340 at 00:54Z**, i.e. climbing) and it is *worthless on its own* — CLAUDE.md: *a delta between two STOCKS is neither a rate nor a sign*. The mechanism settles it in two queries where an arbitrary number of readings could not.

## The finding — the two instruments count different populations

**The clearing job is ALIVE.** The `offsan` card names the wrong pipeline, but the GREATEST-raise mechanism it describes is running: pg_cron **jobid 216 `rpc-raise-edition-offers-backstop`**, `34 * * * *`, `raise_edition_offers_from_chain()`, **6 of 6 recent ticks `succeeded`**. So "the named self-clear is dead" is only half true — the *name* is stale, the *mechanism* is not.

🚨 **But the mechanism cannot clear these flags, by construction.** The two objects disagree on which offers count:

| | offer types in its chain max |
|---|---|
| `v_offer_sanity_flags` (the view) | **ALL** open offers — it merely records `has_sub_serial` as a display column |
| `raise_edition_offers_from_chain()` (the fix) | `WHERE o.offer_type NOT IN ('subedition','serial')` |

So the view flags an edition on a `subedition`/`serial` offer that the raiser is **specifically instructed to ignore**. The flag is re-raised every time the view is read and the backstop is powerless against it.

## Measured live, 2026-09-08T01:0xZ

| | editions | share |
|---|---|---|
| flagged by `v_offer_sanity_flags` | **1,340** | 100 % |
| have **only** `subedition`/`serial` open offers — raiser skips them entirely | **1,048** | 78.2 % |
| have a `subedition`/`serial` offer **as the max** — raiser lifts to the edition-level max, still below the view's max, still flagged | **277** | 20.7 % |
| **actually clearable by the backstop** | **15** | **1.1 %** |

**1,325 of 1,340 are structurally unclearable.** The count is not a backlog with a drain rate; it is a **standing measurement of a definitional difference**, and it will never approach zero however long anyone watches it.

⭐ **This is the [[cross-instrument-sampling-fallacy]] shape at the schema level** — a max computed over one population compared against a column populated from a different one. The repo rule is *never pair a count from one table with a property from another*; here both halves are individually correct and the COMPARISON is the defect.

## Why this is not a user-facing bug (do not panic-fix)

- `edition_offers.highest_offer` is the **edition-level** offer, and it is *correct* that a serial-specific or subedition-specific bid does not set it — those bid on a narrower thing than the edition. **The raiser's exclusion is right.**
- The authoritative trust board is clean on every offer metric (re-confirmed in `2026-09-08T0010Z`: `offer_edition_gap_max_usd` 5, `candy_offers_unverified_pct` 0).
- ⚠ So the defect is in **the instrument and the copy describing it**, not in the data a collector reads.

## The fix — two options, and the choice is a judgement call

1. **Align the view to the raiser** — add `AND o.offer_type NOT IN ('subedition','serial')` to the view's `onchain` CTE, so it compares like with like. `offsan` would then fall to ~15 and *become* a real drain gauge that can reach zero. ⚠ This DISCARDS a signal: nothing would then watch whether a serial/subedition bid exceeds the edition offer, which is a legitimate thing to know.
2. **Keep the view and fix the framing** — retitle it as an informational *"editions whose best chain bid is narrower than edition-level"* metric, drop the "self-clears" claim from the `offsan` card entirely, and stop ranking it as something that ought to trend down.

⭐ **Whichever is chosen, the `rpc-qa-scorecard` `offsan` card detail is WRONG TODAY on both halves** — it names a dead pipeline (`offers-sweep`) *and* asserts a self-clear that could not happen even with the live job (jobid 216) substituted in. **Fixing only the pipeline name would leave the false claim standing**, which is the trap `2026-09-08T0010Z` was one step away from.

## Two instrument notes worth keeping

- ⚠ **`raise_edition_offers_from_chain()` writes NO `pipeline_runs` row** — a `pipeline ILIKE '%raise%'` / `'%edition-offers%'` query returns **zero rows**. Its only record is `cron.job_run_details`, whose `return_message` is `"1 row"` on every tick — **that is the scalar return shape, not the count of rows raised.** The job is invisible to every pipeline-level monitor and its self-report cannot distinguish raising 500 editions from raising none.
- ⚠ **`status = 'succeeded'` on jobid 216 says nothing about whether it did work** — the standing rule that a pg_cron job's `status` is not its work's outcome. The function's own `RETURN v_n` is the count, and nothing persists it.

## Falsifier

If `v_offer_sanity_flags` is ever observed at or near **15** without either the view or `raise_edition_offers_from_chain()` having changed, the mechanism described here is wrong. (Measured 2026-09-08T01:0xZ: 1,340 flagged, 1,325 of them outside the raiser's population by definition.)
