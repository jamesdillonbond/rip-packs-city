# Daytime monitor candidates — 2026-09-12T03:09Z (2026-09-11 20:09 PT)

Source: `rpc-daytime-monitor` evening tick. Read-only sweep. DB **not in a spell** at read time (`pg_stat_activity`: 2 active / 1 IO wait), so causal reads below are interpretable rather than spell-deferred. Security invariants all clean. No ERROR deploys. `rpc-live-health` flagship payload validated (runs clean, all panels return). Inbox written to mount — **bash/clone mount down (3rd night, Sept-8 Windows update); push unavailable, night pass picks up locally.**

---

## 1. HIGH — `snapshot-institutional-wallets` missed its 2026-09-11 daily tick (silent ~41h)
- **Source:** `pipeline_runs` — last run `2026-09-10 10:07Z` (ok, 3 rows). Fired 09-09 and 09-10 at ~10:07Z, both ok; **no 09-11 10:07Z run at all.** Now 09-12 03:09Z → silent ~41h vs the pipeline's 30h (1800-min) cadence threshold; `rpc_ops_snapshot` flags it `high`.
- **Risk read:** LOW data impact (3 rows/day, once-daily institutional-wallet snapshot), but a **daily cron-job.org job that skipped a scheduled day** is a scheduling-health signal, not saturation collateral (it's a single once-daily fire, not a timeout). Matches the historical "silent 45h on 2026-05-08" pattern for this job.
- **Suggested action:** verify the cron-job.org entry for this job is still enabled/active and its schedule intact (was it paused, or did the 09-11 10:07Z fire error at the edge?); confirm the 09-12 10:07Z tick lands. No code change implied yet — this is a cron-console check first.

## 2. MEDIUM — `match-topshot-players` weekly full run (2026-09-11 08:00Z) FAILED on `upstream request timeout`
- **Source:** `pipeline_runs` — `2026-09-11 08:00:06Z` ok=false, 0 rows, `rpc_failed: upstream request timeout`. The 09-09 / 09-10 08:00Z ticks were gated (ok, 0 rows, by design). `rpc_ops_snapshot` `running_but_not_succeeding` arm caught it (the cadence arm can't — it reads max(started_at) with no ok filter).
- **Context:** this is the exact tick **ledger #54 (2026-09-03) recorded as owed** — "the 2026-09-11 tick (≥ 7 days) must be a full run again." It ran, but the full run **timed out upstream and did no work**, and the pipeline is gated to weekly, so it will not self-retry until ~2026-09-18.
- **Risk read:** LOW-MEDIUM — player-name matching goes ~1 week stale; not user-breaking, but the owed verification is now a confirmed miss rather than an open question.
- **Suggested action:** re-trigger the full `match-topshot-players` run (upstream timeout is transient; a re-fire likely succeeds), then confirm `extra` shows a full (non-gated) run and player-match freshness; or accept a 1-week gap until the next weekly tick.

## 3. LOW — `topshot_pack_reality_top_ev` insights board returns 0 rows (verify honest-empty vs starved feed)
- **Source:** `rpc-live-health` payload `insights_counts.pack_reality_top_ev = 0`. The refresh job `rpc-refresh-pack-reality-top-ev` (pg_cron, `34 */2 * * *`) is **healthy** — last 4 runs all `succeeded` (latest 02:34Z, "REFRESH MATERIALIZED VIEW"). So the MV refreshes fine and simply yields no qualifying rows.
- **Context:** `rpc_ops_snapshot` `public_board_empty_count = 0` (this MV is not flagged as a monitored-empty public board), and `pack_ev_board_*` trust metrics are `null`/ok (consistent with an empty board). Adjacent: pipeline alert `pack_distributions` data_stale 8d 22h (the known `updated_at`-is-not-a-freshness-contract stamp; catalog lane bumps it without minted/opened).
- **Risk read:** LOW — plausibly a **legitimate empty** (no packs currently clear the top-EV threshold). Only a concern if the public `/insights/pack-reality` surface renders the empty MV as a false conclusion ("no +EV packs") rather than an honest state, or if `pack_distributions` staleness is silently starving the board.
- **Suggested action:** quiet-window check — is `topshot_pack_reality_top_ev` normally non-empty (history)? Does the public `/insights/pack-reality` route distinguish empty-because-none-qualify from empty-because-source-stale? If the former, no action; if the latter, trace to `pack_distributions` freshness.

---

### Noted, NOT filed as new bugs (saturation collateral / known / by-design)
- pg_cron `statement timeout` / `job startup timeout` cluster this morning: `rpc-refresh-new-collectors` (09:45Z), `rpc-refresh-set-completers` (12:20Z), `rpc-refresh-thin-fmv-guard` (08:30Z), `rpc-fmv-clamp-disconnected-ask` (08:55Z). All during today's documented 17:10/18:15 PT spells; downstream freshness green (`board_mv_refresh_stale_hours` 1.09, `trust_precompute_max_age_hours` 5.3). Saturation collateral per §1c, not N distinct bugs.
- `sales-counterparty-backfill` 30.8% (178/577) fail: **already filed** in today's ledger (2026-09-11) with full plan-shape analysis; not re-logged.
- `fmv-backfill` 72.7%, `lock-check-batch` 25.9%, `price-snapshots` 36.4%, `run-insider-detectors` 32.5%: recurring timeout-under-load, tracked.
- Atlas 403 / flow-rest 400 edge_fn arms: all `info`, self-attributed and benign by design.
- `topshot_impossible_parallel_serials` trust BREACH (value 4 vs 3): **known #82** — the `raise_impossible_parallel_circ()` pin logs repairs a BEFORE trigger reverts; tracked in today's ledger + testing-and-ci.md.
