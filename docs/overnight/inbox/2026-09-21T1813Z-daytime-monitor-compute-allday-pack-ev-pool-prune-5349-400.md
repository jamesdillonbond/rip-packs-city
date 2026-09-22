# Daytime monitor — compute-allday-pack-ev fails EVERY run on `pool prune 5349: Bad Request` (post-R123, unlogged)

**Filed:** 2026-09-21 ~11:1x AM PT (daytime health monitor, read-only sense).
**Instance is CALM at file time** (pg_stat_activity: 1 active / 1 IO-wait) — this is NOT a saturation spell, so the deterministic HTTP-400 is a real fault, safe to attribute.

## One-line title
`compute-allday-pack-ev` has failed on 27 of its last 60 runs (30h) — 100% of the failures are the identical `1 pool write error(s): pool prune 5349: Bad Request`, on the same pool id every run.

## Source
- `pipeline_runs` where pipeline='compute-allday-pack-ev': 60 runs / 30h, 27 failed, all 27 = `pool prune 5349: Bad Request`.
- **Clean onset:** first `prune 5349` failure `2026-09-21 05:07:04Z` (= 2026-09-20 10:07 PM PT); **last OK run `2026-09-21 04:37:03Z`** (= 09-20 9:37 PM PT). Every run since 05:07Z has failed on this one pool.
- Post-dates R123's edge-function verification (ledger 2026-09-20 ~12:37 PM PT PT tick: `pool_write_errors: 0`, 39 dists / 1,565 rows). So this is a regression that appeared ~9.5h AFTER R123 went green, not a pre-existing condition.
- Both same-day migrations (`20260921004437`, `20260921004921`, applied 00:44/00:49Z) predate the onset by ~4h, so they are not the trigger by timing.

## Risk read
- LOW-to-MEDIUM. R123's `ok` is now correctly derived from whether the write landed, so the failed `ok=false` is the instrument working — it is surfacing a genuinely stuck pool (dist/pool **5349**), not a false alarm.
- Blast radius appears contained: trust-health shows NO AllDay staleness breach (`allday_fmv_*`, `pack_ev_*` arms all ok), so user-facing AllDay pack-EV freshness is not visibly degraded — the other ~38 dists look to be writing fine and only pool 5349's prune 400s. Worth the night pass confirming the other dists still persist on a failing run (i.e. that one bad pool does not abort the whole upsert-then-prune transaction).
- Likely a data condition specific to pool/distribution 5349 (a malformed / newly-seeded AllDay distribution, or an edition in that pool that trips the prune request's validation and returns 400), not saturation.

## Suggested action (night pass / not a daytime fix — READ-ONLY pass filed this)
1. Inspect dist/pool 5349: `pack_drop_pool` rows for that pool id and its AllDay distribution row — look for the row(s) the prune request rejects (bad edition_id, out-of-range, null key, etc.).
2. Read `compute-allday-pack-ev`'s prune payload construction for pool 5349 — the 400 is the edge fn's own upstream/PostgREST reply, so capture the exact rejected body from `topshot_*`/pool write error detail before editing.
3. Confirm the run's OTHER dists still write when 5349 400s (upsert-then-prune should be per-pool, not all-or-nothing) — if the whole run aborts, AllDay pack-EV is silently going stale and this escalates.
4. Fix = a code/edge-fn change → Claude Code handoff (Cowork cannot push route/worker/edge code); the daytime pass only senses.
