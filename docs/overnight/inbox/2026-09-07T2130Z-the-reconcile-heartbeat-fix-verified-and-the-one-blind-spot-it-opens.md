# The `wmc-metadata-reconcile` heartbeat fix is VERIFIED against its pre-fix baseline — and it opens one named blind spot, whose closing field already exists but is read by nothing

*Claude Code (cloud), 2026-09-07 ~14:30 PT / 21:30Z · READ-ONLY verification of migration `20260907155956`, shipped by a parallel session · nothing shipped from here*

## 1. The fix works. Falsifier checked against the pre-fix baseline this session measured.

Migration `20260907155956` makes `reconcile_wmc_metadata_from_editions()` log **every** completed tick, zero-write included. Measured over the 5.3 h since it landed (16:00Z), against the pre-fix numbers from the 08:5x PT measurement:

| | pre-fix (~13 h) | post-fix (5.3 h) |
|---|---|---|
| ticks logged / expected at 30-min cadence | **12 / 26** (46%) | **11 / 11** (100%) |
| max gap between rows | **180 min** | **30 min** — exactly the cadence |
| gaps past `max_silent_minutes = 100` | **2** | **0** |
| `extra.no_op` rows (previously invisible ticks) | n/a — not logged | **4 of 11** |
| failed ticks | 0 | 0 |

⭐ **4 of 11 ticks would have been invisible before and are now recorded.** The ~3.7 false alarms/day are gone, and the arm's sensitivity to a genuine stop is untouched: the row is written at tick END inside the same transaction, so a tick that dies rolls its row back and silence still surfaces. **The detector was not modified — only the data it reads.**

## 2. The blind spot it opens, stated precisely

The failure mode **"runs, succeeds, examines its window, corrects nothing — forever"**:

- **Before:** those ticks wrote no row → silence → `detect_stalled_pipelines()` fired after 100 min. It was caught, *incidentally*, by the same mechanism that produced the false positives.
- **After:** they log `ok = true` every 30 min. `detect_stalled_pipelines()` cannot fire (rows are arriving) and `check_pipelines_running_but_not_succeeding()` cannot fire (it keys on `ok_runs = 0 AND work_done = 0`, and `ok` is true).

**Verified, not inferred** — `pg_proc.prosrc` over the two arms keyed on this pipeline:

| function | names `wmc-metadata-reconcile` | reads `no_op` |
|---|---|---|
| `detect_stalled_pipelines` | false | **false** |
| `check_pipelines_running_but_not_succeeding` | false | **false** |
| `reconcile_wmc_metadata_from_editions` | true | true *(it WRITES it)* |

Also checked: **no view and no `cron.job` command reads `no_op`** either.

⚠ **This is not a criticism of the migration — it anticipated exactly this** and added `extra.no_op` as *"the shape-independent field an observer keys on"*. CLAUDE.md's rule is to fix the guard **AND** the field an observer keys on; **the field was fixed, and no observer keys on it yet.** The trade is still clearly right — a daily false positive is worse than a latent gap — but the gap should be named rather than assumed closed by the field's existence.

## 3. ⛔ The obvious arm does NOT work, so do not file it as a quick win

*"Alert on N consecutive `no_op` ticks"* is the shape that suggests itself and it is **wrong here**: post-drain, a long no-op streak is the DESIGNED state (the watchlist row's own note: *"post-drain it writes 2–220 rows/hour by design"*). No threshold on `rows_written` separates *converged* from *wedged*, because both look identical from the self-report.

➡ **Closing this needs an OUTCOME check, not another self-report arm** — "how many `wallet_moments_cache` rows still disagree with `editions`?" — which is CLAUDE.md's own rule (*"Measure the OUTCOME table, not the self-report"*). ⚠ **Size it before building it:** this reconciler was the database's #1 physical reader at the old cadence, so a naive drift-count arm could reintroduce the cost the cadence change removed. Bound the query and compare BUFFERS.

ⓘ **Not urgent.** The blind spot is on a failure mode with no evidence of ever having occurred; `detect_stalled_pipelines()` is `[]` and jobid 456 is 28/28 succeeded. This is a note for whoever next touches that arm, not a queued fix.
