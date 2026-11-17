# Daytime monitor — `snapshot-institutional-wallets` silent ~31h (live HIGH), known chronic class — hand-dispatch, don't re-investigate

*(rpc-daytime-monitor, ~8:18 PM PT 09-20 / 03:18Z 09-21. **READ-ONLY, nothing shipped.**)*

**One-line title:** `snapshot-institutional-wallets` daily lane silent 1,857 min (~31h), past its 1,800-min threshold — the recurring "died mid-run in the night spell, no terminal row" class, needs a hand-dispatch.

**Source:** `rpc_ops_snapshot()` → `pipeline_alerts` + `stalled_pipelines` (severity **high**, `classification: no_marker`); last run **2026-09-19 20:09:31Z**, silent 1,857 min at read time. Confirmed the lane missed its daily fire (no run since 09-19 20:09Z).

**Risk read (LOW risk to act, but needs a caller you have that I don't):** This is the chronic timeout class already tracked (M11 / #42 / #73 / #84; ledger 2026-09-19 documents the identical silence at 1,907 min, hand-dispatched 13:09 PT via the route's own 202 path → ok, 257 pages, 74s). It is **not a new lane defect** — the daily tick reaches the edge function and dies mid-run, leaving no terminal `pipeline_runs` row, so silence-based checks see a stall. It is **NOT** on the "Declined — do not re-suggest" list. The stale holdings snapshot only affects the institutional-wallet surface; no user-facing 500s, security clean, trust-health 0 breaches.

**Suggested action (night pass / Trevor):**
1. Hand-dispatch the lane via its route's 202 path (the proven remedy; last time: ok, 257 pages, ~74s), then confirm a fresh `snapshot_date` row lands.
2. ⭐ **One fresh angle worth a cheap check before assuming the old cause:** the prior silences were attributed to the **night saturation spell on the Small tier**. The instance moved to **LARGE at 09-20 17:39Z** (`pg_postmaster_start_time()`), so a silence recurring *after* the resize suggests the mid-run death may **not** be pure IO saturation this time — if it dies again on LARGE, the cause is the lane's own work, not the tier (do not raise a ceiling; look at the function's paging cost). ⚠ Note this lane is **CONTENT-DRIFTED (#23 / R63)** — a redeploy ships an unknown diff, so a hand-dispatch (not a redeploy) is the safe lever.

**Not re-filed (checked against ledger + live state this run, all known/false-positive):**
- `rpc-weekly-wmc-reindex-6` `latest_status=failed` — **known false-positive**; live command names the valid `idx_wmc_wallet_coll_ek_fmv_tier`; the failure is a stale pre-fix WEEKLY run (fixed 09-19, next real run Sat 09-26). Prior 18:12Z HIGH filing was refuted.
- `sync-nba-projections` `all_upstreams_failed` — register **#8**, permanently-red arm downstream of an operator-gated sports-proxy; deliberately not alarmed, needs the operator.
- `pg_net_http_403` critical arm (7 `{"error":"forbidden"}` in 2h) — consistent with the **documented incomplete gate-key rotation** (7 of 14 crons still on burned keys, `compute-golazos-pack-ev` on the old key; ledger 2026-09-20), needs Trevor's fresh secrets. The bulk of last-2h 403s are Cloudflare "Just a moment…" Atlas upstream challenges (info, retry keeps up).
- Cross-collection mats ~27h stale — one missed daily rebuild (both ccm jobs timed out at 10:02/10:35Z **during the pre-resize saturation**); next scheduled tick 09-21 10:02/10:35Z on LARGE should self-heal. Watch at tomorrow's first-tick pass.
- pack-detail sub-read timeouts (`pack_lifecycle`/`pack_realized_ev` "read exceeded 5000ms") tailed ~3.5h past the resize (last 21:06Z), none in the last ~6h; chronic slow surface (cluster first-seen 08-23), not a new regression.

## Drained 2026-09-22 — STALE BY THE SMALL→LARGE RESIZE — `snapshot-institutional-wallets` 2/2 ok in 24 h, last 5:41 AM PT 09-22.

*(Per-item drained marker, the mechanism `docs/reference/autonomous-tasks.md` names as the unblock for archival. Re-derived live by the 2026-09-22 daytime Cowork pass; archiving remains Trevor's call.)*
