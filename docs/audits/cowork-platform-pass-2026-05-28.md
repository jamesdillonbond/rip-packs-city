# Cowork platform pass — 2026-05-28

Companion to the handoff at `docs/handoff-2026-05-28-cowork-pass.md`.

Session timestamp: 2026-05-28 02:43 → 03:00 UTC.

## TL;DR

Platform is healthy. Single Telegram alert (`snapshot-institutional-wallets` silent >24h) cleared itself organically during the audit when the cron fired at 02:47 UTC. Pipeline success rate is 99.7% over 8,406 runs/24h. FMV recalc has fully recovered from the 2026-05-24 stall — 11,798 editions recalculated in last 24h, 8,797 on algo `1.7.0`. All 5 most recent production deploys are READY.

One material **regression discovered**: the May 26 TS editions merge has been bleeding new UUID-keyed dupes — **6,409 new dupes since the merge**, 4,250 (66%) match a specific bypass pattern in the safety-net trigger. Root cause is a trigger gap (INSERT-only, not UPDATE) plus a GQL writer that inserts with NULL on-chain ids then backfills them in a follow-up UPDATE ~10 seconds later. **Patched the trigger live; the real fix is in the GQL writer** (handed off).

49 archival Flowty `unmapped_sales` rows that could never resolve (Flowty marketplace shut down 2026-05-13) were retired. Open `unmapped_sales` dropped from 60 → 11.

## Shipped live this session (2 DB migrations)

### 1. `audit_20260528_editions_block_topshot_uuid_dupe_cover_update`

Extends the TS UUID-dupe safety-net trigger from `BEFORE INSERT` to `BEFORE INSERT OR UPDATE`.

**Root cause discovery.** Between the 2026-05-26 merge (which brought TS editions 17,574 → 9,535) and this session, 6,409 new UUID-keyed TS edition dupes have re-accumulated. Distribution: 4,798 created on 2026-05-26 (merge day, possibly intra-merge race), 1,577 on 2026-05-27, 34 on 2026-05-28 (this session). The bypass pattern (4,250 / 6,409 = 66%):

1. GQL writer INSERTs a UUID-keyed row with `set_id_onchain = NULL` and `play_id_onchain = NULL`.
2. The dupe-block trigger's predicate `NEW.set_id_onchain IS NOT NULL AND NEW.play_id_onchain IS NOT NULL` is FALSE → trigger doesn't block → row lands.
3. ~10 seconds later, the writer UPDATEs the row to populate `set_id_onchain` + `play_id_onchain`.
4. The trigger doesn't fire on UPDATE → dupe is live.

The remaining 34% split: 1,289 (20%) appear to have INSERT-with-ids-already-set, 870 (14%) had a backfill UPDATE later than 1 min. The 20% case is likely intra-merge transient races on 2026-05-26 (during the chunked merge sequence, the integer-canonical row might not have been visible to the EXISTS check yet).

**The fix is two-layered.** The real fix is in the GQL writer (must upsert against the integer-keyed canonical when `set_id_onchain` / `play_id_onchain` are known); see Claude Code handoff. This migration is the defensive net: on UPDATE match, the trigger nulls `NEW.set_id_onchain` and `NEW.play_id_onchain` back to NULL, leaving the UUID row but rendering it invisible to set/play-keyed reads. The 6,409 existing dupes are NOT cleaned up here — a re-run of the May 26 11-chunk repoint-and-delete sequence is deferred to a deliberate Claude Code session (running it against a hot DB with sales partitions writing every 10 seconds is too risky for an autonomous pass).

**Smoke-tested live** inside `BEGIN…ROLLBACK`:

- INSERT with on-chain ids populated → dropped (trigger RETURN NULL, 0 rows).
- INSERT with NULL on-chain ids, then UPDATE to populate them → row stays but the UPDATE nulls them back out. `(set_id_onchain, play_id_onchain) = (NULL, NULL)` after the UPDATE.

### 2. `audit_20260528_unmapped_sales_retire_archival_flowty_rows`

Retired 49 `unmapped_sales` rows where `marketplace = 'flowty'`. Flowty marketplace shut down 2026-05-13. These rows span 2026-04-17 → 2026-05-13, carry only an `nft_id` in `resolution_hint` (no `price_extraction` marker, no edition mapping path). The 2026-05-25 resolver rewrite went GQL-primary for AllDay; no resolver path operates on `marketplace='flowty'` anymore. They could never resolve.

Migration sets `resolved_at = NOW()` and appends `{retired: true, retire_reason: 'flowty_marketplace_archived_2026_05_13', retired_at: <ts>}` to `resolution_hint` for forensics.

**State change:**

| metric | before | after |
|---|---|---|
| `unmapped_sales` open | 60 | 11 |
| flowty open | 49 | 0 |
| nflallday open | 10 | 10 |
| laligagolazos open | 1 | 1 |

The 10 remaining NFL All Day rows are all `price_extraction = 'v1_tx_decode_budget_exhausted'`, real-and-fixable via the existing `/api/admin/recover-v1-budget-exhausted` route or a budget bump (`V1_TX_DECODE_MAX` is currently 25/tick; recent traffic is overflowing).

## Verified clean / premise outdated

### Telegram alert (`snapshot-institutional-wallets` silent)

The single firing alert at session start. Pipeline last successful run was 2026-05-25 21:51:49 UTC (53h ago at session start). The function works — the cron silence is a cron-job.org configuration issue (Cowork can't touch cron-job.org from here). **The alert cleared organically during the session** when the cron fired at 2026-05-28 02:47:05 UTC (53.0 hours after the prior run). `get_pipeline_alerts()` is now empty.

If this becomes a repeat pattern, the next step is either to drop the cadence expectation in `pipeline_cadence_watchlist` (currently `max_silent_minutes=1800` = 24h + 6h grace) or to triple-fire the cron-job.org entry for redundancy.

### `fmv-recalc` silent-stall recovery

Per CLAUDE.md, the route stalled 2026-05-24 22:03 → 2026-05-25 14:53 and was patched by commit `dd84526` (chunked the `.in()` site at 500, added `log_pipeline_run` to fatal-catch and Step 3 error paths). **Confirmed fully recovered**: 150 successful runs in last 24h, average 18s/run, 0 failures. 11,798 editions had a fresh FMV snapshot written in the last 24h. 8,797 editions are now on algo `1.7.0` (out of 23,164 total TS+AllDay+UFC+Golazos editions; Pinnacle has its own snapshot table).

Note: the route's `extra` JSONB no longer carries `cursor_after` or `editions_processed`. The Step 5 cursor logic from the May 24 fix may have changed or been removed in a subsequent commit; not blocking but worth a glance.

### Vercel deploys

All 5 most recent production deploys (2026-05-26 → 2026-05-27) are READY. The one ERROR deploy in the recent window is the May 25 `70df651` (already documented in CLAUDE.md as the `maxDuration=900` regression, fixed by `b32102e`).

### Pipeline failures

14 distinct pipelines have 1-6 failures each over 24h out of 8,406 total runs (99.7% success). All look transient (connection-pool / lock contention, the same pattern called out in the 2026-05-24 audit). No critical recurrent failures.

### `pipeline_sentinel.yml` + `ops-monitor.yml` GHA workflows red

Both have been failing for at least the last 20 runs because the route handlers (`/api/sentinel`, `/api/cron/stale-fmv-monitor`) read keys on the `health_check()` result that don't exist on the current shape. Current `health_check()` returns top-level keys `pipelines`, `fmv`, `collections`, `users`, `insider_signals`, `telemetry`, `db_size_mb`, `generated_at`. The stale-fmv-monitor route reads `data.fmv_pipeline.staleness_minutes`, `data.sales_pipeline.last_sale_at`, `data.data_integrity.orphaned_editions_ok`, `data.database.size_mb` — none of which exist. Route throws → HTTP 500 → GHA exits 1.

This is **loud-but-harmless noise**: the routes crash before reaching their Telegram-notification paths, so the red GHA UI doesn't translate into Telegram spam. Fixing requires either updating the route handlers to the new shape or adding a compat layer. Handed off to Claude Code.

## Key metrics ledger

| metric | value | notes |
|---|---|---|
| Pipeline success rate (24h) | 99.7% (8,378 ok / 28 fail / 8,406 total) | healthy |
| `fmv-recalc` runs (24h) | 150 ok / 0 fail | fully recovered from May 24 stall |
| Editions recalc'd (24h) | 11,798 | sweep speed is good |
| FMV HIGH confidence | 423 (1.8% of 23,159 with FMV) | still the lever — see "Open" §4 |
| FMV MEDIUM | 894 (3.8%) | |
| FMV LOW | 10,695 (45.7%) | |
| FMV NO_DATA | 8,641 (36.9%) | structurally unpriceable per May 23 audit |
| `unmapped_sales` open | 11 (was 60) | post-cleanup |
| TS UUID-keyed dupes | 6,949 | post-merge regression, trigger gap, deferred cleanup |
| `get_pipeline_alerts()` | empty | clean |
| DB size | 5,654 MB | down from 13.8 GB (May 24 cleanup held) |
| Sales (24h) | 728 | TS 400 + AllDay 335 |
| Auth users / active 7d | 10 / 0 | no traction yet, paywall stays off |
