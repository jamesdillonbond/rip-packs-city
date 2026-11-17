# Daytime monitor — 2026-08-22T1509Z (~08:06 PT, first-tick-of-day)

**Run posture: SEVERE saturation spell in progress — SYMPTOMS only, no causal claims.** Positive control (Section 1c) taken FIRST: `pg_stat_activity` = **31 of 32 active sessions in IO wait, 43 total** (io_wait/active/total = 31/32/43). This is worse than the 08-20 severe spell (24/27) and the 08-22 nightly's MODERATE band (4–5 of 5–6). `rpc_ops_snapshot()` **timed out** (`57014 canceling statement due to statement timeout` on statement 1) — itself the spell signal, per SKILL Section 1c.

Under spell discipline I did NOT run the heavy DB probes (they add IO to what they measure and every duration is uninterpretable): skipped `detect_stalled_pipelines`, `check_pgcron_recent_failures`, the `v_rpc_trust_health` first-tick view (times out ~60s even when healthy), the cross-collection first-tick verify, and all artifact payload queries. These re-run on a later, quieter tick.

## What WAS read (cheap / non-DB-IO, trustworthy in a spell)

- **Security: clean.** Direct catalog reads (no heavy IO): `rls_off_tables = 0`, `anon_write_holes = 0`. No security finding.
- **Vercel: healthy.** Latest production deploy `dpl_6vQR8KsjMvw9RdwQY4bwTLCn95jX` (sha `5998292`, "fix(ci): add the anon-exec marker to the rwfc migration") = **READY**. No `ERROR` state in the last 20 deployments; the single newest entry is `CANCELED` (sha `c60dd3c`), the normal superseded-by-next-push pattern, not a failure. All recent deploys authored from Trevor's local box.

## Candidate (SYMPTOM — quiet-window re-measure, NOT a cause)

- **Title:** Severe disk-IO saturation spell at ~08:06 PT (31/32 active sessions in IO wait) — symptom observed under saturation.
- **Source:** `pg_stat_activity` positive control; `rpc_ops_snapshot()` timeout.
- **Risk read:** none new. This is the documented disk-IO-budget root cause on the SMALL instance (CLAUDE.md; focus.md priority 3). A morning-band peak, consistent with the 08-21 "band is a PEAK phenomenon, average 9.4 MB/s vs 22 MB/s floor" ranking. Do NOT read it as a new pipeline outage — the sweep could not observe pipelines and does not claim one.
- **Suggested action:** RE-MEASURE in a genuinely idle window before any conclusion. Do not attribute to any single consumer, do not quote a cost, do not raise a timeout. The already-queued work-cutting levers (cross-collection mats step1/step2, `refresh_wmc_fmv_changed` 120×, pack-EV lateral) remain the correct decision/off-limits-gated response — this filing adds a datapoint to the peak-severity distribution, nothing more.

## Known/queued — NOT re-raised as new (per ledger + focus)

Cross-collection mats 124h stale (ccm-step1/2 timing out since 08-18, night 3, queued); demand gate 21 users / 0 WAU unchanged since 08-18; `topshot-active-listings-ingest` ~67% `egress_blocked` (atlas-proxy operator item); git push dead from sandbox (no creds) blocking code deploys. The three standing trust breaches (`panini_sale_price_capture_dry_days`, `unmapped_resolution_backlog_max`, `public_board_slow_count`) are known-class per focus.md STEER.

*Inbox written to mount, push unavailable (sandbox has no push creds; `remote.origin.pushurl` empty per 08-22 nightly lock note). Night pass picks it up locally.*
