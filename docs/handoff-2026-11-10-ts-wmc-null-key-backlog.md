# Handoff — Top Shot wmc null-`edition_key` backlog (two saved wallets)

**Source:** weekly data-quality & reconciliation sweep, 2026-11-10 (~9:20 AM PT, Cowork cloud, read-only). Digest: `claude/data-quality-sweep-2026-11-10.md` (project). Ledger: `docs/overnight/ledger.md` 2026-11-10 HEALTH-ONLY entry.

> **STATUS 2026-11-10 3:10 PM PT (Claude Code, laptop):** item 1 — `0xc246d05ba775362e` cleared to 0 by 2:27 PM PT (not by the healer); 604 left, all `0xe68c3edbdc6c9376`, draining at ~20/h — no cap change (the 20 is sized under the access node's burst limit). Item 2 — **DONE 4:23 PM PT**: second slot `rpc-topshot-wmc-null-key-heal-backlog` (job 863, `:57`, same 20-read cap) runs only while > 100 rows are key-less — doubles the drain under a backlog, idle otherwise (migration `20261111002347`). Item 3 — **DONE**: `v_rpc_trust_health.topshot_wmc_null_edition_key_rows` (breach 1000), migration `20261110230853`. Correction: a watcher DID exist — `check_wmc_null_edition_key` in `rpc_ops_snapshot()` (09-29, total > 100) — but it is a session read, not an alarm.
>
> **STATUS 2026-11-10 6:14 PM PT:** 520 left (all `0xe68c3edbdc6c9376`); both slots green (`:57` filled 20 at 4:57 and 5:57, `:27` filled 14 at 5:27 — a few reads lost to the `:2x` 429 band). ETA to < 100 ≈ 11–12 h (early morning 11-11 PT), after which job 863 idles. Nothing left to do here; close this handoff once the count reads ~0.

**Severity:** Needs attention — user-visible, contained, resolvable. Not a correctness bug; not a drain regression.

## What

`wallet_moments_cache` for Top Shot (`collection_id = 95f28a17-224a-4025-96ad-adf8a4c63bfd`) holds **5,207 rows with `edition_key IS NULL`**, up from the usual ~0. The wmc contract (`edition_key` must equal `editions.external_id`) is violated by the NULLs, so these moments are invisible to every edition-keyed surface (holdings player/edition/FMV, counts).

All 5,207:
- have `moment_id` populated (so they are resolvable — nothing malformed);
- have NULL `edition_key`, `player_name`, `set_name`, `tier`, `serial_number` (skeleton rows);
- were created 11-09 ~9:32 AM – 5:42 PM PT (a single wallet-walk window);
- belong to **two `saved_wallets`**:
  - `0xc246d05ba775362e` — **4,583 of 9,171** TS rows (~50% of this whale unhydrated)
  - `0xe68c3edbdc6c9376` — 604 of 3,238

Other collections are clean: All Day 1 (structural floor), UFC 0, Golazos 0.

## Why it isn't clearing on its own

The dedicated healer `topshot-wmc-null-key-heal` (pg_cron, hourly `27 * * * *`) is **healthy** — 48/48 runs ok in 48h — but hard-capped at `reads_dispatched = 20` per run. Recent `extra`:

```
16:27Z filled 20  waiting 5227  reads_dispatched 20  refused_impossible_serial 0
15:27Z filled 12  waiting 5239  reads_dispatched 20
14:27Z filled 20  waiting 5267  reads_dispatched 20
...
05:27Z filled 20  waiting 5447  reads_dispatched 20
```

~20 healed/hour against a ~5,200 backlog ⇒ **~11 days to drain**. `refused_impossible_serial = 0` and `filled > 0` every run confirm the rows are resolvable; the only constraint is the per-run read cap. (Companion `topshot-moments-hydrate-wmc` scans 15k/run and sees only ~9–21 unresolved — that queue is the normal small residual, separate from this backlog.)

## Suggested fix (NOT shipped — config/ingest, outside the sweep's read-only + additive-monitoring allowance)

1. **Clear the backlog fast.** Raise `topshot-wmc-null-key-heal`'s per-run read cap well above 20 (the walk/heal path is the limiter, not the DB — compute is LARGE), or fire a one-off burst/targeted heal for the two wallets, so a bulk multi-wallet walk clears in hours, not ~11 days. Confirm both wallets reach 0 NULL `edition_key`.
2. **Decide the steady-state cap.** 20/run is fine for trickle churn but cannot absorb a bulk saved-wallet walk; consider scaling the cap with observed `waiting`, or raising cadence while a backlog exists.
3. **Add a continuous watcher.** There is currently **no `v_rpc_trust_health` leg** for TS wmc null-`edition_key`; this weekly sweep is the only thing that sees it. A cheap leg (count of TS wmc rows with NULL `edition_key`, breach above a few hundred) would page on the next bulk-walk spike instead of waiting up to a week.

## Verify / revert

- Confirm cleared: `SELECT count(*) FROM wallet_moments_cache WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND edition_key IS NULL;` → expect ~0.
- No revert needed for a cap/cadence bump (healer already runs). If a new trust-health leg is added, revert = drop the leg.

## Measured query (reproduce)

```sql
SELECT w.wallet_address, count(*) AS null_key_rows,
  EXISTS(SELECT 1 FROM saved_wallets sw WHERE sw.wallet_addr=w.wallet_address) AS is_saved,
  (SELECT count(*) FROM wallet_moments_cache a
     WHERE a.wallet_address=w.wallet_address
       AND a.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd') AS total_ts_rows
FROM wallet_moments_cache w
WHERE w.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND w.edition_key IS NULL
GROUP BY w.wallet_address ORDER BY 2 DESC;
```
