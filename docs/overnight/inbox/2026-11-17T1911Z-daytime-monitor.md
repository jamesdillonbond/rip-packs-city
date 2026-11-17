# Daytime health monitor — 2026-11-17 ~19:11Z

Read-only sweep. Platform health otherwise GREEN: security all `[]`, trust_health 42/42 ok (0 breaches), sentinel TS-48h 0, pg_cron failures none, 13/13 live dashboards' referenced objects resolve, last Vercel prod deploy READY (`77b268b`), client_error beacon 0/24h. Positive control: io_wait 4 / active 4 — **not** a saturation spell, readings interpretable.

## HIGH — GHA scheduled workflows STILL dark; the morning re-registration did not take
- **Source:** `gha-schedule-watchdog` (pg_cron, healthy — last run 19:08Z) reporting "no schedule-tagged tick in 594 min (last 2026-11-17 08:43:43Z); 1 cadence lane breaching" at its 18:38Z tick. Confirmed: `topshot-sales-history-backfill` last ran 01:53Z and `pinnacle-owner-discovery` last ran 02:05Z — both 0 runs in 6h (their ~5–6h GHA cadence has lapsed).
- **Context (already logged, ledger 2026-11-17 ~8:17 AM PT entry):** `2e021e372` deleted `.github/` at ~1:16 AM PT; the morning pass disabled→enabled all 30 workflows via REST (16:15Z) and then pushed a one-line trailing comment to each of the 30 workflow files (~16:35Z) to force GitHub to re-register the crons. **This filing's new fact:** ~2.5h after that re-registration push, STILL zero schedule-tagged ticks have landed, and the two low-cadence GHA data lanes above are now dark since ~02:00Z. The morning fix was **ineffective so far.**
- **Risk read:** Data-freshness blast radius currently **LOW** — trust_health is fully green because the high-frequency ingest runs on pg_cron / cron-job.org, not GHA. What is dark: the GHA-scheduled monitors/backstops (Site Availability Alarm, Pipeline Sentinel, Sales Indexers Backstop) and the two low-cadence data lanes. Monitoring gaps, not data loss — but if this persists it will. Cause undetermined: either a GitHub Actions platform scheduler delay (common, self-clears) or the re-registration genuinely did not stick (githubstatus is robots-blocked to this session — cannot attribute from here).
- **Suggested action (night pass / Trevor):** Re-verify whether any GHA schedule has fired since 16:35Z; if still dark, re-attempt registration (another trivial workflow-file push, and confirm no workflow is in GitHub's auto-disabled state) and keep the backstops dispatched by hand meanwhile. Check githubstatus for an Actions incident from a surface that can reach it. READ-ONLY sense only — no action taken this pass.

## LOW — panini-team-walk upstream failure rate 28.6%
- **Source:** `rpc_ops_snapshot()` pipeline_alerts: "4/14 runs failed (28.6%) over the last 3 calendar days. Last error: page 113: no readable products response after 4 attempts." Not in ledger.
- **Risk read:** Upstream Panini fetch flakiness on one page, 4-attempt retry already in place. Low — no FMV/coverage breach (panini_coverage_pct_drop 5.7 < 15, panini_fmv_stale_hours 5.3 < 36 both ok). Likely transient upstream.
- **Suggested action:** Re-measure next run; only act if the rate climbs or panini coverage/FMV staleness arms start breaching.

## Known / no new action (noted for completeness)
- `hybrid_custody_backfill` 2/6 (33.3%) statement timeout — the 90s timeout mitigation (`20261115172736`) is applied and tracked (ledger 11-15); occasional trips remain within tolerance. No new filing.
- Several Atlas `edge_fn_http_error` info rows (403/404 on market/pack/editions/autograph/ask-book lanes) — all designed Cloudflare-challenge behavior with recent last-200s; none at their escalation thresholds. Healthy.
