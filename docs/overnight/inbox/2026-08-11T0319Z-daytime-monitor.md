# Daytime monitor — 2026-08-11T03:19Z (20:19 PDT Aug 10)

Environment: workspace shell DOWN again (`useradd … /sessions no space left`, 4th consecutive incident) → no git clone. Connectors (Supabase/Vercel/Sentry/cowork) + file tools work. This file was written to the MOUNT; **push unavailable** — night pass picks it up locally. Not the ~8am tick, so Section 1a (trust-health-watch / cross-collection verify) intentionally skipped.

Health: security 4/4 clean · `detect_stalled_pipelines()` = pinnacle-sync (known cron-job.org drop) + candy-listings-indexer (info, unpublished) · trust 3 breaches ALL known (panini dry 13, public_board_slow 1↓, unmapped backlog 195) · DB 12,452 MB · sentinel TS-uuid-48h 0.

---

## Candidate 1 — [HIGH-watch, likely already remediated] trust-precompute cron first scheduled tick after today's per-leg-split cutover FAILED permission-denied

- **Source:** `check_pgcron_recent_failures()` — `rpc-trust-health-precompute-refresh` (jobid 222), `last_run 2026-08-11 00:58:00Z`, status **failed**, `ERROR: permission denied for procedure rpc_trust_health_precompute_refresh_p`. This is the ONLY run in that job's `job_run_details` history → the job was just cut over.
- **What changed:** today's D34-prerequisite ship (`68fb505c` → `879f2dc1`, ledger 2026-08-10) split the precompute into per-leg functions driven by a per-leg-COMMIT **INVOKER** orchestrator and repointed pg_cron 222. The cron command is now `CALL public.rpc_trust_health_precompute_refresh_p()` (was the old SECDEF fn). The 00:58Z tick — the first scheduled run under the new command — hit a missing EXECUTE grant for the cron role.
- **Appears ALREADY remediated (do not double-fix blindly — verify first):** as of 03:19Z, `has_function_privilege('cron_heavy','public.rpc_trust_health_precompute_refresh_p()','EXECUTE')` = **true** (cron_heavy is jobid 222's role), and `trust_precompute_max_age_hours` = **1.89** (ok) — since that arm reads `max(age)` over ALL precompute rows, a 1.89h max means every row was rewritten ~01:27Z, i.e. a FULL run succeeded after the grant went in (very likely a manual verify run by the shipping session). So the grant is now present and the whole INVOKER→per-leg chain executed end-to-end at least once.
- **Why it still needs a night-pass eyeball:** the failure has NOT yet been cleared on a *scheduled* tick — the next one is **06:58Z 08-11**. Confirm it succeeds. If it re-fails permission-denied, the top-level orchestrator is now executable but the INVOKER body still lacks EXECUTE on one or more per-leg SECDEF callees for `cron_heavy` — grant EXECUTE on the remaining per-leg procedures/functions to `cron_heavy` (the per-leg objects do NOT share the `rpc_trust_health_precompute_refresh%` prefix — only 2 objects match it: the old fn + the `_p` orchestrator — so enumerate the callees from the orchestrator body, not by name pattern).
- **Blast radius / clock:** the precompute is the load-bearing sentinel/trust-board refresh. Not user-facing right now (max_age 1.89h vs breach 13h, and `v_rpc_trust_health` only maps a row to 999 at >24h). But if every 6-hourly tick were to fail, `trust_precompute_max_age_hours` breaches ~12:58Z→next, then the board goes progressively stale. Risk is a regression that self-inflicts a red board, not a data-loss.
- **Suggested action:** night pass — read `job_run_details` for jobid 222 at/after 06:58Z; GREEN = close this candidate; RED-again = grant EXECUTE to `cron_heavy` on the per-leg callees enumerated from the orchestrator body, then re-verify. Read-only monitor did NOT touch grants.
- **✅ GRANT CHAIN VERIFIED COMPLETE — 2026-08-11 ~03:45Z (Claude Code, interactive, read-only).** Enumerated the callees from the orchestrator body as instructed (it is INVOKER, `prosecdef=false`, and `PERFORM`s exactly 8 per-leg SECDEF functions with a `COMMIT` after each: `rpc_thp_leg_{panini,pinnacle_fmv_share,pack_ev,fmv_sanity,serial_supply,fmv_coverage,board_liveness,impossible_parallel}`). `has_function_privilege('cron_heavy', …, 'EXECUTE')` = **true for all 9** (orchestrator + all 8 legs). So the "RED-again" branch above has **no work left to do** — do NOT grant anything. The only residual is confirming the 06:58Z *scheduled* tick itself succeeds; if it fails, the cause is NOT a missing per-leg grant and should be diagnosed fresh. ⚠ Note the legs do not share the `rpc_trust_health_precompute_refresh%` prefix (they are `rpc_thp_leg_%`), exactly as this candidate warned.

## Candidate 2 — [LOW / known class, new Sentry ID] series-detail page statement-timeout

- **Source:** Sentry `JAVASCRIPT-NEXTJS-27` "series detail unavailable: canceling statement due to statement timeout", culprit `GET /[collection]/series/[slug]`, first+last seen ~00:26Z, **2 events / 1 user**.
- **Read:** same disk-IO-saturation slow-query class as tonight's pg_cron timeouts and the standing D3b non-sargable-`lower()` slug-scan backlog (11 prod fns still carry it; `get_series_detail` resolves a URL slug). Not a code regression — it's the entity-page pool-acquire-under-saturation family (cf. NEXTJS-1Y/20 team/player pages). Low volume, single user, one saturation window.
- **Suggested action:** no new work — folds into the existing D3b sargability follow-up. Escalate only if event count climbs across multiple non-saturation windows.

## Candidate 3 — [known cluster, already queued] MV-refresh statement-timeout cluster

- **Source:** `check_pgcron_recent_failures()` — `rpc-refresh-misattrib-candidates` (15:35Z), `rpc-thin-sale-ask-disclosure-refresh` (09:25Z), `rpc-ccm-step2` (04:25Z), all `canceling statement due to statement timeout`, each 1/1 in window, all daily/self-retrying.
- **Read:** the standing disk-IO-saturation MV-refresh cluster already profiled and queued in `inbox/2026-08-08T1717Z*` + `2026-08-08T1945Z*` (query-weight/contention, not config; do-not-bump-timeout). No new signal. Listed only so the night pass can confirm they self-recovered on their next ticks.

---

## NOT findings (dispositioned)

- **`rpc-reconcile-saved-wallet-stats` (jobid 259) failed 13:33Z statement-timeout** — this is a PRE-FIX scheduled run. The 08-10 Claude Code session REBUILT this job after that tick (pass-2-first, ungated, 6h freshness skip); its 300.4s kill is one of the "2 of 2 prior attempts committed nothing" it recorded. Expected to make partial progress on the next 13:33Z 08-11 tick. Do not re-file.
- **pinnacle-sync silent ~41h** — external cron-job.org tick drop, already dispositioned by the 08-10 CC session (item 2 of its 1509Z read): the `/api/admin/backfill-pinnacle-catalog` Vercel backstop covers catalog and Pinnacle FMV is on separate pg_cron; `pinnacle_fmv_stale_hours` 4.7 / render-floor 1.6 both ok. Operator-side, LOW.
- **sync-nba-projections (all_upstreams_failed), topshot-active-listings-ingest (egress_blocked), wallet-username-resolver + wallet-backfill-* + allday-buyer-backfill timeouts** — all the documented infra-gated / disk-IO-saturation classes; no new code lever.

## Not deep-validated this run
- **Artifacts:** not deep-validated (shell down + DB under active saturation — followed the 08-10 night-pass precedent of not piling heavy payload queries onto a saturated pooler). No schema-breaking DDL landed today (per-leg precompute split changed refresh mechanics not read-schema; the DISTINCT-ON board fix + reconcile rebuild are query-internal), so estate risk is low; last full estate check was ~19h ago (08-10 night pass, healthy vs D33). Night pass should re-validate when the shell/DB recover.
