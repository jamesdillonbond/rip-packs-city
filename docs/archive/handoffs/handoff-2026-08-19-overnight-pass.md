# Overnight autonomous pass — 2026-08-19 (~01:20 PT)

**Mode: NO-PUSH** (desktop Cowork: `remote.origin.pushurl` absent, `git push --dry-run` fatal — no creds). DB migrations + artifact repairs would still apply; code commits/Vercel deploys are queued for Trevor. **Outputs are UNPUSHED, mirrored to the mounted tree.**

**Outcome: quiet honest night. Shipped 0, reverted 0, artifacts repaired 0.** Security clean 4/4. Health is green-or-known-class except one genuine new data drift (queued below). An active disk-IO saturation spell was in progress the whole run (positive control: 9/10 active sessions in IO wait), so per focus.md no cost/cause claims are drawn from durations and nothing saturation-class was investigated as a new bug.

## Setup / gates
- Lock: prior lock RELEASED and >24h old → took over. Claimed, will mark RELEASED on exit.
- FREEZE: absent.
- Real time verified vs DB: shell 08:03Z ≈ DB `now()` 08:03:47Z ≈ `max(sales.ingested_at)` 08:03Z. No skew. 01:03 PT = genuine overnight window.
- Push: `git push --dry-run origin main` → `could not read Username` → NO-PUSH confirmed. Consistent with the standing escalation and focus.md priority 2 (sandbox NO-PUSH is expected; Trevor's local box can push).

## Post-ship regression watch (last ~24–48h)
No regression attributable to any recent ship. Confirmed wins:
- **wmc-fmv-confidence scoping (21ab85ef, 08-18):** was the top pgcron failer last night (rpc-backfill-wmc-fmv-confidence 47/286). **Absent from tonight's pgcron failures entirely** → fix working.
- **Top Shot series-filter fix (fdf84ee4):** deployed READY, is the current production build.
- **get_fmv_coverage single-probe (f5ecb69e) + migration 20260818205106:** no regression on the data-integrity route.
- 1 historical Vercel ERROR (drain-fmv-cold-tail heartbeat commit) was superseded by later READY builds; its code is in production via those builds. Nothing to revert.

## Health-drift findings + deltas
- **Security: clean 4/4.** `check_public_security_invariants()` [], `check_anon_write_surface()` [], `secdef_anon_exec_drift` clean, RLS-off public tables 0, anon/authenticated write holes 0.
- **Trust health: 4 breached / 19 precompute arms.** Diffing the SET vs last night (not the count):
  - **NEW & genuine — `topshot_impossible_parallel_serials = 6` (breach_at 3).** See QUEUE #1. Not saturation; real data drift. Precompute row fresh (0.37h old), so value=6 is a true reading (not the 999 stale-sentinel).
  - **NEW & saturation-class — `fmv_sweep_stall_pct_24h = 51.3` (breach_at 50).** fmv-recalc page-zero/saturation family; marginal. Same root as the now-cleared `fmv_sweep_wedge_hours`.
  - `public_board_slow_count = 4` (breach_at 1) — saturation collateral, **improved from 14**.
  - `unmapped_resolution_backlog_max = 322` (breach_at 100) — known AllDay permanent floor; do NOT raise breach_at.
  - **Cleared since last night:** `board_mv_refresh_stale_hours` (8.06→ok), `fmv_sweep_wedge_hours` (8.06→ok).
- **pgcron recent failures: 10, all `statement timeout`** on MV-refresh / cache-insert legs = disk-IO saturation collateral, zero logic errors. One root cause; not investigated.
- **Stalled pipelines: 4, all known/benign.** `candy-editions-ingest` (timeout class, handed off 08-04), `candy-listings-indexer` (logging-defect cry-wolf — runs & writes on ~1/3 ticks), `wallet-username-resolver` (128m silent; watchlist threshold 75m is likely stale vs the 3h cadence — see QUEUE #2), `topshot-moments-hydrator` (44m, info).
  - **Resolved the daytime monitor's one open candidate:** `allday-pack-opens-backfill` (job 55) silence was ambiguous (spell vs scheduler-stop). Cheap catalog reads settle it: `active=true`, schedule `6,16,26,36,46,56 * * * *`, **36 succeeded runs in 6h, latest 08:16Z**. → firing normally; the `pipeline_runs` silence is the by-design SPORK_FLOOR `done:true` standby, not a scheduler stop. Close as saturation/standby collateral.
- **Sentry: 0 new issues in 24h.** 8 unresolved entity-page issues (`rpc get_*_detail timed out after 45000ms` on edition/team/set/player/pack) — firstSeen ~23h, **lastSeen ~18h ago**, concentrated in the 08-18 daytime saturation window, none in the last 18h. Honest-degradation path working (surfaces "unavailable", not fabricated data). Known-class (unbounded entity-page reads + saturation).
- **Vercel: healthy.** Latest production READY = fdf84ee4. Docs tip 4219cbf8 CANCELED = expected `ignoreCommand` skip. 0 unresolved ERROR.
- **Deltas:** DB 13191→13336 MB (+145). Editions 27199→27228 (+29). **Demand gate 21 users / 1 WAU — unchanged.** All normal drift.

## Shipped
None (NO-PUSH; nothing DB/artifact-shippable was outside the off-limits set — see triage).

## Queued — needs your decision / a quiet window

### QUEUE #1 — `topshot_impossible_parallel_serials` drifted 0→6 (genuine data drift, off-limits to auto-fix)
Six Top Shot sales are keyed onto `::`-parallel editions with `serial_number > circulation_count` (impossible serials = F1 parallel mis-attribution). This is the exact class the arm was built to page after the 0→6 `offer_fill` drift on 2026-07-02. It is invisible to the editions-flat / UUID / FMV sentinels. **Off-limits for autonomous fix** (sales attribution / ingest data), and its identifying query timed out mid-spell, so the 6 rows are not yet enumerated.

Ready-to-run, in a quiet window (compare against `pg_stat_activity` IO-wait first):
```sql
SELECT s.id AS sale_id, e.id AS edition_id, e.external_id, e.circulation_count,
       s.serial_number, s.sold_at, s.ingested_at, s.nft_id, s.collection
FROM editions e
JOIN sales s ON s.edition_id = e.id
WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  AND e.external_id::text ~ '::'
  AND e.circulation_count > 0
  AND s.serial_number > e.circulation_count
ORDER BY s.ingested_at DESC;
```
Then decide: are these mis-keyed sales (should re-attribute to the base edition) or a stale `circulation_count`? The 4 writers are already guarded, so this is most likely a small batch that slipped in before a guard or via a path the guard misses. Fix touches sales attribution → Claude-Code-owned code change, not a night-pass auto-ship.

### QUEUE #2 — `wallet-username-resolver` cadence-watchlist threshold likely stale (small, low value)
The watchlist row measures `max_silent_minutes = 75` against a "7d median gap 30min" baseline, but per focus.md SENTINEL DECISION-QUEUE item 2 Trevor cut the resolver cadence to **every 3h** (cron-job.org). At 3h cadence a 128-min silence is normal, so this arm will cry-wolf. **Confirm the actual cron-job.org cadence first** (operator-only — I can't read it), then if it is 3h:
```sql
-- reversible; note original 75 in the commit
UPDATE pipeline_cadence_watchlist SET max_silent_minutes = 220 WHERE pipeline = 'wallet-username-resolver';
```
Low value; only worth it to stop the recurring false stall. Not shipped tonight because the cadence is unconfirmed from here and it's not urgent.

### Long-standing (carried, not re-litigated)
- **`drain_fmv_cold_tail` unscoped aggregate** and **`compute_pack_ev_per_edition_weighted` lateral `fmv_current` leg** — both measured, both blocked on Trevor's decision (the pack-EV fix forces a pinned-fixture re-seed), and both must be **measured in a quiet window** — tonight was a spell, so no re-measure was attempted. Still queued.
- The saturation family (fmv-recalc kill rate, board-slow, pgcron timeouts, entity-page Sentry timeouts) — one root cause, lever is cutting work not raising timeouts; not a night-pass item.

## Failed / blocked / reverted
None. No verification failures (nothing shipped), no reverts, no hard-stop.

## Continuity
- `docs/overnight/metrics-latest.json` overwritten with tonight's vector (mirrored to mount, unpushed).
- Ledger NOT spliced (nothing shipped — matches last night's discipline).
- Inbox NOT archived (focus.md rule: inbox files are permanent citation targets).
- Lock marked RELEASED on the mount.
