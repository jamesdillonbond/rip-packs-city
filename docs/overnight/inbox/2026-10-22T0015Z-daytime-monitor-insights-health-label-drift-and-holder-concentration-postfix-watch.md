# Daytime monitor — 2026-10-22 ~00:15Z (~2026-10-21 5:15 PM PT) · infra GREEN · 2 low candidates

Read-only daytime health sweep. Platform GREEN: `rpc_ops_snapshot()` security all `[]`, sentinel ts_uuid 0, `detect_stalled_pipelines()` `[]`, `check_pgcron_recent_failures()` `[]`, 37/38 trust arms ok (the 1 breach = known #58 candy_sales_stale, Trevor-only, 236.8h). Vercel: no ERROR deploy (prod actively BUILDING — Trevor shipping live), all 5 runtime-error groups chronic/known. Artifact validation: 16/16 dashboards' payload queries reference only live DB objects. Positive control io_wait 1/6 active → NOT a spell, causal reads valid.

⚠ NOTE: written to the MOUNT, push unavailable — the sandbox has no `/sessions/<id>/mnt` tree this run, so `.rpc-git-cred` is unreachable from the sandbox clone (and must not be copied in); sandbox-native push per GIT ENVIRONMENT cannot run. INDEX.md NOT updated here (mount fallback writes the file only); the night pass adds the INDEX line + runs the fixer when it next commits. Clone used read-only for repo reads (HEAD fac029a).

---

## 1. (LOW · dashboard label drift, cosmetic) rpc-insights-health dashboard labels its squeeze-check RPC `get_wallet_squeeze`, but the live function is `get_wallet_squeeze_exposure`

- **Source:** `docs/cowork-skills/rpc-insights-health.html:76` — `const WALLET_TOOLS=[["/insights/squeeze-check","get_wallet_squeeze (RPC)"],...]`. The 1b object-existence check found `get_wallet_squeeze` is the only one of 80 referenced names absent from the live DB (`pg_proc` has `get_wallet_squeeze_exposure`, not `get_wallet_squeeze`; `rpc-live-health.html:583` uses the correct name).
- **Risk read:** NONE to data. The string is a display caption only — it renders the squeeze-check row as an "interactive" pill and runs NO SQL. Every executed payload query (`Q_COUNTS`, `Q_FRESH`, the wallet-tool queries) references live objects. So the dashboard is not broken; the label is just imprecise/stale.
- **Suggested action (safe, one line):** in `docs/cowork-skills/rpc-insights-health.html`, change the caption `"get_wallet_squeeze (RPC)"` → `"get_wallet_squeeze_exposure (RPC)"`, then re-publish that one artifact (per rpc-artifact-ops). No DB change. Trivially revertible.

## 2. (LOW · post-ship watch) Verify the panini-holder-concentration refresh job's first SCHEDULED tick succeeds under the 10-21 single-pass MV + 300s fix

- **Source:** `pipeline_runs` — `panini-holder-concentration` shows 2 of 4 runs/24h `ok=false` with `error='canceling statement due to statement timeout'`, last_fail 2026-10-21 14:58Z, last_ok 15:14Z (8:14 AM PT). Shipped same day: ledger 2026-10-21 (Holders tab) migrations `20261021145526` (300s SET on the cron command) + `20261021150457` (single-pass MV); the MV is populated (37,197 editions) and manual warm runs at 8:09/8:14 AM PT ran ok=true.
- **Risk read:** LOW / likely already-cleared. The 2 timeouts predate the ~11 AM PT fix, so they are STALE pre-fix runs (the class Section 1 says not to alarm on). But the fix's success was only read on MANUAL warm runs; the first SCHEDULED tick of pg_cron 775 `rpc-panini-holder-concentration` (~5:29 AM PT daily) under the single-pass MV + 300s window has not been observed. No live user harm (tab renders from the populated MV; a failed read shows "couldn't load").
- **Suggested action:** on the next pass that spans/after the ~5:29 AM PT tick, confirm the scheduled `rpc-panini-holder-concentration` run is `ok=true` within the 300s window and `detect_stalled_pipelines()` does not list it. If it times out at the scheduled load (vs the lighter manual warm), the single-pass MV refresh needs further tuning (same class as the refresh-conflated-editions 120s→300s + compute-before-truncate fixes). Sense/verify only — do not re-tune here.
