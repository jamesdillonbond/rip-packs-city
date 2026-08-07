# Handoff — `topshot-pack-opens-history-backfill` wedged on a persistently-transient spork range (2026-08-07)

**Why a handoff and not a ship:** the fix touches a spork-routed Deno edge function
(`supabase/functions/ingest-topshot-pack-opens-history/index.ts`) and cannot be verified from the
cloud sandbox — Flow REST / spork egress is proxy-blocked here, so there is no way to reproduce the
failing range or prove a fix end-to-end. This is cursor/ingest logic where a wrong change causes
silent data loss, so it needs an operator with spork-reachable testing. Diagnosis below is complete;
pick option A (safe, no data loss) or B (operator decision).

## Symptom (sentinel alert)
`topshot_pack_opens_history_backfill · cursor_stalled — Cursor updated 15h+ ago at block 61808846`.

## Root cause (fully diagnosed against live `pipeline_runs`)
The backfill walks DOWN toward `SPORK_FLOOR` (27,341,470), scanning each window **descending** and
checkpointing `scannedFloor = hi + 1` so partial progress survives a flaky upstream. Since ~2026-08-06
22:11 UTC it has been hard-wedged: the **leading** 250-block chunk of the current window,
`[61808596, 61808845]`, fails **every run** with `events 61808596-61808845 status 0`
(`status 0` = the `fetch` threw — timeout/connection reset, after 3 tries @ 15s each).

Because the *first* (topmost) chunk fails, `scanOpens` returns `scannedFloor = hi + 1 = 61808846`,
i.e. equal to `cur`, so `progressed = after < cur` is false and the cursor never advances. The run
logs `ok=false` (correct — nothing moved) and pages. 67 wedged runs / 16.4h continuous as of
2026-08-07 14:26 UTC; before that it was making normal interleaved progress, so the range itself is
genuinely not recovering (it is NOT the whole spork — other spork-routed ranges succeeded).

## The code gap
`skipped_permanent` only triggers on a **non-transient** error (`(!!err || !!rerr) && !anyTransient`,
line ~343). A range that fails *transiently* (`status 0`) forever has **no escape hatch** — the
descending-checkpoint design is monotonic under a *flaky* upstream but wedges permanently against a
*consistently dead* leading chunk. `status 0` is classified transient (`isTransient`, line 127-129),
which is right for genuine flakiness but wrong for a range that is 100%-dead.

## Fix options

### Option A — adaptive sub-chunking on a transient LEADING-chunk failure (safe; NO data skipped)
In `scanOpens`, when a chunk fails transiently, retry it as smaller sub-windows (e.g. halve
`EVENT_RANGE` down to a floor of ~10-25 blocks) before giving up. If the cause is query heaviness /
per-query timeout on that spork, smaller windows get past it and the walk resumes. If even the
smallest window fails, behaviour is identical to today (hold the cursor — no data loss). Strictly
safe: it never advances past unscanned blocks. **Must be dry-run in `?mode=probe` against a
spork-reachable env for that height before deploy.**

### Option B — bounded permanent-skip after N consecutive identical-range transient failures (operator decision — SKIPS DATA)
After M consecutive runs where `scannedFloor == cur` on the same leading chunk, treat that chunk as
permanently unreachable: advance the cursor past it (`after = lo - 1`) and record the skipped range
(a new `pipeline_runs.extra.skipped_range` + optionally a `backfill_skipped_ranges` row) for later
re-walk. **This LOSES those ~250 blocks of 2022-era TS pack-opens provenance** (this window is below
the 61,930,346 Dapper-registry bulk-load line, so it is *real discovery*, not re-verification). It
unwedges the 34M-block journey at the cost of one documented gap. This is a data-completeness
tradeoff — Trevor's call, not autonomous.

## Immediate manual unwedge (if desired now, before any code change)
```sql
-- Steps the cursor past the dead 250-block leading chunk. SKIPS [61808596, 61808845].
-- Only durable if the failure is range-specific (it is, per the diagnosis above) — if the whole
-- spork [55114467, 65264618] is down it will re-wedge one chunk lower within ~15 min.
UPDATE event_cursor SET last_processed_block = 61808595, updated_at = now()
WHERE id = 'topshot_pack_opens_history_backfill';
```
Same data-loss caveat as Option B. Verify the next run's `progress_blocks > 0` afterward.

## Not a defect (verified, do not "fix")
The descending-checkpoint + hold-on-transient design is correct and load-bearing (it is the 2026-08-01
fix that stopped the fn discarding 100-query windows). The wedge is the *missing escape hatch* for a
permanently-dead range, not the checkpoint logic.
