# Daytime monitor — 2026-11-02T07:13Z — artifact-validation roster drift (#114): 11 named vs 16 live sources

**Run:** rpc-daytime-monitor, 2026-11-02 07:13Z (fired 07:12Z). Read-only sweep; platform HEALTHY — snapshot security clean, trust 37/37 ok, 0 stalled pipelines, 0 pg_cron failures, cross-collection mats fresh, latest prod deploy READY, no new runtime-error spike (the 4 error groups are all chronic, low-count, graceful-degradation timeouts).

## Candidate (LOW risk — doc/roster maintenance, NOT a broken query)

**Title:** The monitor's §1b artifact-validation roster lists 11 Cowork dashboards, but `docs/cowork-skills/` holds 16 ported dashboard HTML sources — 5 live dashboards sit outside the validated set.

**Source:** `docs/cowork-skills/*.html` (16 files) vs the monitor prompt's §1b roster and `docs/reference/known-issues.md` #114 name->URL map (11). The 5 extra: `rpc-insights-health`, `rpc-pipeline-reliability`, `rpc-rookie-supply-ladder`, `rpc-security-drift`, `rpc-trade-in-value-finder`. The #114 register note itself reads "15 live Cowork dashboards (last measured 09-14)", so the drift is three-way: prompt 11 / register 15 / disk 16.

**Risk read:** Low. This run validated all 16 regardless: every table/view/function the 16 pages' SQL references resolves live (to_regclass + pg_proc), including the extra set's objects `get_topshot_player_rank_thresholds`, `get_topshot_supply_breakdown`, `topshot_rookie_collector_leaderboard_mv`, `get_topshot_trade_in_value`, `check_secdef_anon_execute_violations`. No missing object, no broken dashboard query. The only exposure: a future daytime run following the 11-item roster would skip 5 live dashboards and could miss a schema break in them.

**Suggested action (night pass):** reconcile the #114 name->URL map and the monitor's §1b roster to the 16 live sources — add the 5 above, or record why any are excluded from validation. Pure docs; no DB or code change.

**Disposition — 11-02 ~2:25 PM PT (Claude Code cloud): RESOLVED in the register at 8:45 AM PT** (`docs(#114): roster reconciled — 13 live dashboards, 3 retired sources`, Cowork cloud). Independently confirmed from the live artifact listing: 13 published claude.ai artifacts (the 11 + Rookie Supply Ladder + Trade-In Value Finder, Candy Chain Two Onboarding among the 11); `rpc-insights-health`, `rpc-pipeline-reliability`, `rpc-security-drift` have no artifact and are the documented retired sources. The daytime-monitor prompt's §1b roster is Trevor's to edit (not a repo file).
