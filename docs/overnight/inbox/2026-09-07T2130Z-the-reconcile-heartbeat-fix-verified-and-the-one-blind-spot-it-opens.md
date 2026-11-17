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

---

## ✅ SIZED — 2026-09-07 14:24 PT, Claude Code on Trevor's box (the session that shipped `20260907155956`)

This section answers §3's explicit ask — *"size it before building it… bound the query and compare BUFFERS"* — and stops short of building, for the reason §2 gives.

**1. The naive drift check is as expensive as §3 feared. Confirmed WITHOUT running it** (plan only — running it is the thing we are trying to avoid). The direct expression of "how many `wallet_moments_cache` rows still disagree with `editions`", mirroring the reconciler's own five-branch predicate:

```
Parallel Hash Join  (cost=4278.59..143916.84 rows=759184)
  ->  Parallel Seq Scan on wallet_moments_cache  (cost=0.00..136982.52 rows=1011231)
  ->  Parallel Hash -> Parallel Seq Scan on editions  (rows=12125)
Finalize Aggregate  (cost=146814.91..146814.92)
```

A full sweep of ~1.01 M Top Shot `wmc` rows every tick. ⛔ **Do not build this arm.** §3's warning is upheld on the plan.

**2. A bounded instrument already exists, and nothing needs to be created to use it.** `idx_wmc_metadata_fillable` is a partial index on `(collection_id, edition_key)` covering exactly the rows with a missing metadata field. Counting through it, **measured with `EXPLAIN (ANALYZE, BUFFERS)`**:

```
Index Only Scan using idx_wmc_metadata_fillable   (actual time=1.936..1.986 rows=20)
  Heap Fetches: 0
  Buffers: shared hit=12 read=4          -- 16 buffers total
Execution Time: 2.068 ms
```

⚠ **16 buffers and 146,814 are different units** (measured buffers vs a planner cost estimate) — they are not a ratio, and the second was deliberately never executed. What the two together support is only the qualitative claim: one is an index-only touch of 16 pages, the other is a two-table sequential sweep.

**3. The converged baseline is `20`.** Per collection today: NBA Top Shot **20** · NFL All Day 284 · UFC Strike 4,614 · Disney Pinnacle 56,295. ⓘ Only the Top Shot number is this reconciler's business — `reconcile_wmc_metadata_from_editions` hardcodes the Top Shot uuid — so the other three are neither drift nor a defect here, and an arm must scope to the collection or it will fire permanently on Pinnacle.

**4. ⚠ What this cheap instrument is STRUCTURALLY BLIND TO — the reason it is not simply a drop-in for §3's ask.** Two gaps, both on the "does it disagree" half:

- **Empty strings.** The index predicate is `tier IS NULL OR player_name IS NULL OR …`, but the reconciler fills on `COALESCE(w.player_name, '') = ''`. **A row whose `player_name` is `''` is fillable to the reconciler and invisible to this index.** Not measured here: the only honest way to count them is the seq scan item 1 rules out.
- **The CORRECT half entirely.** A row whose `tier` / `set_name` / `mint_count` is present but *disagrees with the catalog* has no NULL, so it is absent from the index. That half is precisely what makes item 1 expensive, and this instrument does not see any of it.

➡ So a cheap arm is available **for the fill-with-NULL half only, at 16 buffers**, and it must say so — naming what it cannot see, per this repo's own rule that a passing guard's silence has to be characterised.

**5. ⛔ Deliberately NOT shipped, and the reason is §2's own argument.** Adding `extra.fillable_backlog` to the reconciler's row would cost ~16 buffers against a function that already reads far more — but it would be **another field with no observer**, which is the exact criticism §2 makes of my `extra.no_op`. Adding a second unread field to answer the first one is not progress. The remaining decision is *where the observer lives* (a trust-board arm in `rpc_trust_health_precompute_refresh`, which CLAUDE.md flags as timeout-prone and whose arm count already drifts), and that is a real design call rather than a mechanical follow-through — so it stays a note, still not urgent, now with its numbers attached.
