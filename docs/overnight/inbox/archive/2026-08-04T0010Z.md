# Daytime monitor candidates — 2026-08-04T00:10Z (17:10 PT Aug 3)

Health sweep GREEN except three KNOWN/tracked trust breaches (all self-clearing or documented; see output). Two new low-risk candidates below, both in the **statement-timeout-on-unbounded-partition-scan** class that today's `c571e9f3` / `8e62cf26` classify-acquisitions fix addressed — so the fix pattern is proven and in-hand.

> Inbox written to the MOUNT, push unavailable — the bash/git sandbox failed this run (`useradd: cannot create directory`). Night pass picks this up locally.

---

## 1. (MEDIUM) `allday-unmapped-resolver-tail` — 42.9% fail on `load_open: canceling statement due to statement timeout`
- **Source:** `rpc_ops_snapshot()` pipeline_alerts (failure_rate 6/14 over 2d); confirmed live.
- **Read:** The `load_open` query drives an unbounded scan of partitioned `sales` — the exact non-sargable pattern the 08-03 classify-acquisitions fix bounded with `sold_at >= COALESCE(p_since,'-infinity')` (measured 42.9s → 3.5s on a 14d window; only the COALESCE plan prunes partitions). The tail resolver is "low-yield" and the MAIN unmapped resolver is healthy (~2.2k resolved/24h), so this is an **efficiency/observability** fix, not a correctness fix — the backlog is unaffected.
- **Suggested action:** Apply the same bounded-window (`p_since` + `COALESCE`-sargable predicate) to the tail resolver's `load_open`. ⚠ Ingest-adjacent — likely **operator / Claude Code**, not autonomous night-pass (unmapped-sales resolver logic is off-limits for auto-ship).
- **Risk:** Low if it mirrors the proven c571e9f3 pattern exactly + keeps the regression-test discipline (COALESCE not OR-form).

## 2. (LOW) `wallet-username-resolver` — 45.9% fail (39/85 over 2d) on statement timeout
- **Source:** `rpc_ops_snapshot()` pipeline_alerts + `pipeline_fails_24h` (18/24h).
- **Read:** Documented recurring "saturation-family" enrichment resolver (ledger 07-16/07-17). Enriches wallet usernames — **cosmetic, non-critical**; a failed tick drops no data. Rate is elevated but the pattern is old and benign. Same unbounded-scan-timeout shape as #1.
- **Suggested action:** Bound / throttle its scan window, or downgrade its alert arm if the timeout is by-design on a drained backlog. Low priority — investigate before touching.
- **Risk:** Low; non-critical enrichment.

---

## Known / NOT re-filed (context only)
- **`fmv_sweep_stall_pct_24h` = 82.5 (BREACH)** — DECAYING stale-24h artifact. The 08-03 cursor fix (`484d08d7`) is confirmed working: sweep verified advancing `cursor_before 4000 → 9500`, `has_more=true`, page_size=500. Self-clears once pre-fix `cursor_before=0` runs age out of the 24h window.
- **`public_board_slow_count` = 3 (BREACH)** — marginal/known. candy_special_serials_board fixed 08-03 (`3655cf44`); the probe refreshes only 6-hourly (pg_cron 222) so it can read slow up to 6h post-fix. The other two topshot boards sit 2–4% over budget = threshold question, Claude Code declined to "fix".
- **`unmapped_resolution_backlog_max` = 105 (BREACH)** — documented honest-open-finding since 08-01 in its own `catches` text ("DO NOT raise breach_at"; needs a permanent-failure-reason column to exclude the AllDay permanent-class floor). Tracked.
- **pg_cron `rpc-refresh-allday-pack-realized`** MV-refresh timeout (1/4, 18:35Z) — recurring transient IOPS class, already logged 08-03. Not new.
- **Sentry NEXTJS-23** (player-page statement timeout, 1 event 14h ago) — documented deliberate entity-page saturation class. Not spiking.
