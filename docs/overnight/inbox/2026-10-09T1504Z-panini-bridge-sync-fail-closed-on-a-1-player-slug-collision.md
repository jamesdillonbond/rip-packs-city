# panini-bridge-sync is fail-closed every tick on a 1-player slug collision

- **Filed:** 2026-10-09 ~15:04Z (daytime health monitor, read-only, mount-only per monitor-filing precedent — committing to origin reds `inbox-index-lists-every-filing`).
- **Spell check:** NOT spell-observed. Positive control at 15:04Z `io_wait=0, active=0`. The error is a deterministic `P0001` RAISE, not a timeout — safe to characterize causally.

## What

`panini-bridge-sync` (pg_cron `rpc-panini-bridge-sync`, `:14/:44`, `sync_panini_bridge()`) is `ok=false` on every recent tick with:

```
P0001: sync_panini_editions_to_shared: refusing to write -- 0 set and 1 player slug collisions would [occur]
```

`extra`: `pct_stale_45d 0.0` (the 45-day staleness gate PASSES), `catalog_drift 1`, `efc_written null`, `snapshots_written null`, `duration_ms ~0.6-0.8s`. So this is NOT the stale-45d gate — it is the catalogue-sync's slug-collision fail-closed guard aborting the whole bridge transaction.

## Source

- Pipeline: `panini-bridge-sync` (`pipeline_runs`), ~10 fails/24h at 15:04Z; 8 consecutive failing ticks observed 11:14Z -> 14:44Z, all identical message.
- Function: `sync_panini_editions_to_shared(false)` called inside `sync_panini_bridge()` (shipped 2026-09-25, ledger). The RAISE rolls back the whole tick, so neither the catalogue sync NOR the `panini_fmv_snapshots -> fmv_snapshots` copy / `edition_fmv_current` upsert lands.
- Onset: after the 08:08Z overnight sweep (overnight-2026-10-09 handoff did not list it; ~10/24h fail count implies onset ~10:00Z). NEW this daytime window.

## Risk read

- **Fail-closed = no bad data written.** The guard exists to stop a colliding player slug from corrupting the shared editions catalogue; it is doing its job.
- **Blast radius: Panini FMV is not propagating into the SHARED plane** (`fmv_snapshots` / `edition_fmv_current`) while blocked. Primary Panini surfaces read `panini_fmv_snapshots` directly and are unaffected; trust arm `panini_fmv_stale_hours` = 0 at 15:04Z. The staleness is confined to shared-table / cross-collection consumers of Panini FMV. No site, security, trust, or FMV-accuracy-gate impact at filing time.
- Low urgency, but it does not self-recover: the colliding slug persists until resolved, so every tick keeps failing.

## Suggested action (night pass / Claude Code — off-limits for the monitor)

1. Identify the 1 colliding player slug driving `catalog_drift 1` (two `panini_editions` players normalizing to the same shared `players.slug`).
2. Either resolve the data collision (dedupe/rename the colliding slug source-side) so the catalogue sync passes, OR refine `sync_panini_editions_to_shared` to skip-and-log the single colliding slug and continue (so one collision stops blocking the whole bridge, matching the skip-and-log pattern used elsewhere). Ingest/catalogue route-logic = owner's lane; do not ship from a monitor.
- **Acceptance:** `panini-bridge-sync` returns `ok=true` with `snapshots_written`/`efc_written` non-null; shared `fmv_snapshots` for `collection_id = 'd1a0a7f5-...'` (Panini) resumes updating.
- **Revert of any fix:** standard; no destructive change implied.

## ✅ RESOLVED (Claude Code, indexed 2026-10-09 ~11:00 PM PT)

FIXED 10-09 ~8:25 AM PT by `20261009150720`: a case variant ("In-Beom Hwang" vs "In-beom Hwang"). `sync_panini_editions_to_shared` now counts collisions on `lower(btrim(name))` and upserts one spelling per slug; a non-case collision still refuses. The 8:14 AM PT run was ok with 454 rows.
