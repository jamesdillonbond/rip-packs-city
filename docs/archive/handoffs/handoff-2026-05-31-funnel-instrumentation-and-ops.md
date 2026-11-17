HANDOFF — Funnel-top instrumentation + absence-of-runs ops wiring
Date 2026-05-31. DB enablers already shipped LIVE this session (verified); this handoff is the code/scheduled-task wiring Cowork can't do. My repo mount is behind your latest commits — verify against current code; your inspection wins.

DB ALREADY LIVE (do not recreate):
- funnel_events table — RLS on, anon INSERT-only (no anon SELECT), event_type allowlisted, text cols length-capped, service_role reads. Index on (event_type, created_at). Migration audit_20260531_funnel_events_table.
- detect_stalled_pipelines() — returns active cadence-watchlist pipelines past their max_silent_minutes as JSON. Service_role only. + the 4 *-sales-indexer pipelines added to pipeline_cadence_watchlist (TS 180m/high, AllDay 90m/high, Golazos+UFC 90m/medium). Migration audit_20260531_watch_sales_indexers_and_detect_stalled_pipelines.
- get_rpc_traction_snapshot() — one-JSON traction snapshot (powers the rpc-traction artifact). Service_role only. Migration audit_20260531_add_get_rpc_traction_snapshot.

GUARDRAILS: direct to main, no branches/PRs; PowerShell git + verify push; no CRLF string-replace patches; tsc clean.

=====================================================================
ITEM A — Emit funnel_events at the top of the funnel (Task 20)
=====================================================================
WHY: we can measure conversions (signups/clicks/concierge) but NOT anon arrivals — so we can't tell if the wallet-paste + sitemap fixes drove traffic. funnel_events (live) is the sink.
EMIT (anon-safe; the table grants anon INSERT, so a client insert via the supabase anon client works — model it on however outbound_clicks is written today, e.g. the /api/track-click path or a direct insert):
- event_type 'home_view' — on HomePageMarketing mount.
- event_type 'wallet_paste' — in HomePageMarketing.tsx classifyAndRoute/submit (the ANALYZE box), with wallet_address (or the raw input) + session_id.
- event_type 'share_view' — on /share/[wallet] load, with wallet_address.
- event_type 'insights_view' — on /insights hub + each /insights/* surface load.
- optional: 'share_cta_click' (the /share signup CTA), 'insights_card_click'.
Columns: event_type (required, must be in the allowlist), wallet_address, session_id, surface, referrer. Keep it fire-and-forget (don't block render; swallow errors). Reuse the existing session_id scheme outbound_clicks uses so sessions reconcile.
VERIFY: load /share/<wallet> logged-out → a row appears: SELECT event_type, count(*) FROM funnel_events WHERE created_at > now()-interval '1 hour' GROUP BY 1. Then the rpc-traction artifact can add a funnel section (share_view → signup) — say the word and I'll extend get_rpc_traction_snapshot + the artifact once events flow.
REVERT: remove the emit calls (table is harmless if unused).

=====================================================================
ITEM B — Wire absence-of-runs detection (Task 21)
=====================================================================
WHY: topshot-sales-indexer went silent 01:32-08:02 UTC undetected — the monitor scans pipeline_runs for ok=false, not absence, and no *-sales-indexer was even on the watchlist (now fixed). detect_stalled_pipelines() (live) returns the silent ones.
WIRE:
1. rpc-daytime-monitor (Cowork scheduled task — its prompt lives in Cowork, not the repo): add a step that calls detect_stalled_pipelines() and surfaces any rows as candidate findings. This closes the "scans failures, not silence" gap.
2. Optional repo: /api/sentinel and/or /api/check-alerts — add a check that calls detect_stalled_pipelines() and pages (Telegram) on severity='high' rows, so silence alerts run on the same cadence as error alerts.
3. Q5 (smoke lag threshold): in app/api/smoke-test the sales-lag check flaps degraded because it measures lag from the newest sale. Rebase it to measure from the last successful indexer run (max(started_at) in pipeline_runs for the indexer), not the newest sale — a quiet market then reads healthy while a genuine indexer stall still trips.
VERIFY: detect_stalled_pipelines() currently returns pinnacle-resolve-buyers (live stall) — a good test row.

=====================================================================
OPERATOR NOTE (live finding)
=====================================================================
pinnacle-resolve-buyers is currently STALLED — 284 min silent vs its 180-min watchlist threshold (severity high). Likely its external cron-job.org trigger stopped (same class as the TS-sales-indexer stall). Worth a re-fire/check; detect_stalled_pipelines() will keep flagging it until it runs.

EXPECTED END STATE
Item A → anon arrivals (home/share/insights views + wallet-pastes) land in funnel_events; the traction board gains a real top-of-funnel → conversion view. Item B → pipeline SILENCE is alerted, not just errors; the smoke lag check stops false-flapping. Both close gaps the nightly pass surfaced.
