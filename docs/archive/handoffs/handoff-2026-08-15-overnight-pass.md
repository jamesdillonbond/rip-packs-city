# Overnight autonomous pass — 2026-08-15 (01:05 PT)

**Mode: MONITOR + NO-PUSH (8th consecutive night the sandbox shell is down).** Genuine overnight window (01:05 PT, inside 00:00–06:00, no clock skew — DB `now()` 08:05Z, FMV `computed_at` 08:02Z three minutes old), so normal shipping WOULD be permitted — but `mcp__workspace__bash` fails identically (`useradd exit 12`, `/sessions` no-space) on both attempts, so there is **no git clone and no push**. DB migrations + artifact repairs + Sentry/Vercel reads + direct mount file access are all GREEN; code commits/deploys are impossible this run. **Shipped 0 / reverted 0 / repaired 0.** Outputs written to the mount, UNPUSHED.

Additional reason nothing was DB-shipped even though DB writes were available: the instance is in an **active disk-IO saturation spell** right now (statement timeouts across many pipelines + pg_cron MV refreshes). Running a new migration or `CREATE INDEX CONCURRENTLY` mid-saturation is the wrong time — it would compete for the throttled IO budget and likely time out. No additive-DB candidates were queued in the inbox anyway (inbox empty).

## Capabilities this run
- device bash: **DOWN** (useradd exit 12, `/sessions` no-space; failed identically twice — not retried further)
- git: **UNAVAILABLE** (no shell → no clone, no push)
- Supabase MCP: GREEN (reads; the heavy `rpc_ops_snapshot` FMV-share leg + any `sales.ingested_at` scan time out under saturation — used lighter per-leg checks)
- Vercel MCP: GREEN (list_deployments)
- Sentry MCP: GREEN (0 new / 0 regressed / 48h)
- Cowork artifacts: GREEN (list_artifacts; 11 artifacts, none flagged broken)
- mount file access: GREEN (Read/Write/Glob against `C:\Users\TDill\rip-packs-city`)

## Continuity state read
- **Lock:** was RELEASED (prior run 05:19Z / 22:16 PT Aug 14). Claimed at 08:05Z, released at end of this run.
- **focus.md:** stale (2026-06-24, all post-ship items long resolved). Only the standing pg_cron-failure-check note still applies — done this run.
- **inbox/:** EMPTY on the mount (no `*.md`). The daytime monitor's shell is also down, so no new candidates were harvested. Nothing to drain/archive.
- **metrics-latest.json:** prior run 05:18Z (OFF-HOURS monitor+nopush).
- **Latest handoff:** `docs/handoff-2026-08-14-overnight-pass.md`.

## Post-ship regression watch — PASS, 0 reverts
Since the prior pass, a concurrent Claude Code session pushed a large batch of interactive code/DB work to `origin/main`, and Trevor pushed `c25e0f5` (committing the stranded 08-14 NO-PUSH artifacts + two corrections). Re-measured:
- **Sentry: 0 new / 0 regressed over 48h.**
- **Vercel: current production tip `15c7dc4f` (retire tautological Pinnacle FMV drift guard) READY. Across all 20 recent deploys every state is READY or CANCELED — ZERO ERROR deploys.** CANCELED = docs-only `ignoreCommand` skips or superseded-by-newer-push builds (expected).
- The live disk-IO saturation wave is the **documented burst-credit-throttle class**, NOT traced to any ship (it is MV refreshes + heavy aggregations timing out, not new logic). `public_board_empty_count = 0` → no user-facing board broken.
- Nothing attributable to a ship, nothing to revert.

Two refinements Trevor's `c25e0f5` landed (folded into the queued items below):
1. **compute-pinnacle-pack-ev fix `bd53bb3a` was never DEPLOYED** (not "ineffective"): it made the dedupe COUNTED, and `extra ? 'dist_dupe_count'` is false on all 10 recent runs. It is a Supabase edge function so it never appears in a Vercel deploy scan — that scan cannot decide deployed-vs-not in either direction. Remedy is a deploy, still operator/CC (pack-EV + edge deploy off-limits; also blocked by unset `PINNACLE_PACK_EV_GATE_KEY`).
2. **pg_net_http_403 CRITICAL is ONE job (jobid 16), not "a subset of the 14"** — 71 of the 403s land on jobid 16's cron minutes, 0 on the others.

## Section 2 — health-drift findings + deltas

**Security: 4/4 CLEAN.** `check_public_security_invariants()` null, `check_anon_write_surface()` null, RLS-off base tables `[]`, secdef-anon (covered by invariants) clean.

**Sentry: 0 new / 0 regressed (48h).**

**Vercel: production READY (`15c7dc4f`), 0 ERROR deploys in the last 20.**

**Trust breaches (3, all KNOWN class — unchanged from prior nights):**
- `panini_sale_price_capture_dry_days` = **18** (was 17; +1/day, as expected). KNOWN — Panini home-box runner outage; operator-owned. FMV itself is fresh (only new-price CAPTURE is dry).
- `public_board_slow_count` = **9** (was 6 at 05:16Z; 1 at 08-14 03:12Z; 16 on 08-11) — oscillating UP with the live saturation spell. `public_board_empty_count = 0` → collateral slowness, no board broken/empty.
- `unmapped_resolution_backlog_max` — AllDay permanent-class floor (alerts show 47,524 actionable of 106,070; 58,546 are multi-NFT-tx frozen-by-design). Live inflow 43/24h < outflow 74/24h → net-draining. `info` severity.

**Pipeline alerts — dominated by a disk-IO SATURATION WAVE (documented class, self-healing/oscillating; NOT a logic defect, NOT traced to a ship):**
- `compute-pinnacle-pack-ev` 9/9 fail — deterministic `ON CONFLICT DO UPDATE cannot affect row a second time`. KNOWN, operator/CC (see refinement 1 above; fix undeployed).
- `topshot-active-listings-ingest` 11/14 fail — `egress_blocked`. KNOWN (GHA runner IP WAF-blocked ~83%; atlas-proxy is the fix, inert pending operator `wrangler deploy`).
- `wallet-username-resolver` 63/106, `lock-check-batch` 48/105, `refresh_wmc_fmv_changed` 143/435, `populate-pinnacle-wmc-fmv` 19/55, `allday-buyer-backfill` 5/18, `allday-unmapped-resolver-tail` 7/18 — all `statement timeout` / `connection pool` / `upstream timeout`, the burst-credit-throttle class. `refresh_wmc_fmv_changed` is the documented #2 disk reader (112 GB, mean 330s) whose intermittent timeouts are its normal saturation behavior.
- `pg_net_http_403` CRITICAL 24/2h — recurring gate-key half-rotation; now attributed to **jobid 16 alone** (refinement 2). Operator: complete the rotation as ONE window.
- `candy-listings-indexer` cron_silent 633m (info) — known no-op under ME quest-hold; `candy_mlb` unpublished, board reads directly. Not user-facing.
- `unmapped-sales-nfl_all_day` growth (info) — the AllDay floor above.

**pg_cron recent failures (`check_pgcron_recent_failures()`) — a wave of MV-refresh / heavy-aggregation `statement timeout`s, all the same saturation class:** `rpc-refresh-allday-pack-realized` (3/4, last 06:35Z, `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_allday_pack_realized`), `rpc-ccm-step1` (cross_collection_cohort_mat INSERT), `rpc-refresh-challenge-costs` (07:20Z), `rpc-refresh-new-collectors` (mv_ts_buyer_first_buy), `rpc-reconcile-saved-wallet-stats`, `rpc-refresh-misattrib-candidates`, `rpc-pinnacle-fmv-recalc-backstop`, `rpc-thin-sale-ask-disclosure-refresh`. These leave the affected MVs/rollups STALE, not broken — they refresh on the next tick once the burst budget recovers. Nothing here is a genuine post-fix recurrence; all are timeouts under load.

**Deltas vs prior run (metrics-latest 05:18Z):**
- DB size 12,917 → **12,929 MB** (+12, normal growth).
- public_board_slow_count 6 → **9** (saturation oscillation).
- panini dry days 17 → **18** (+1/day expected).
- Sentry new/regressed 0 → **0**.
- Security 4/4 clean → **4/4 clean**.
- FMV freshness: FMV `computed_at` 08:02Z (3 min old) → price path alive.

## Shipped
None (NO-PUSH; DB deferred due to active saturation + no queued additive candidate).

## Reverted / auto-reverted
None (post-ship watch clean).

## Repaired (artifacts)
None (11 artifacts, none flagged broken; fresh-on-open, no drift to fix; re-verifying all 11 against a throttled DB would add load for no signal).

## Queued — needs operator / Claude Code (all carried, none newly autonomously actionable)
1. **ESCALATION — free the `/sessions` volume.** The sandbox shell has been down 8 consecutive nights (`useradd exit 12`, no space), which blocks ALL overnight git push and the daytime monitor's inbox archival. Delete old Cowork sessions per `docs/handoff-2026-08-09-cowork-shell-recovery.md`. Until this clears, every night pass is DB+artifacts-only and outputs strand on the mount (Trevor's `c25e0f5` shows the manual catch-up: commit the stranded files by hand).
2. **pg_net_http_403 CRITICAL (jobid 16).** Complete the gate-key rotation as ONE window (the 8 `*_GATE_KEY` secrets + deploy env-var fns + repoint cron `?key=`) per the `2026-08-11T0300Z` runbook. Now pinned to a single job, which should make the rotation target unambiguous.
3. **compute-pinnacle-pack-ev HIGH (9/9 fail, deterministic).** Fix `bd53bb3a` exists but is UNDEPLOYED (edge function; `dist_dupe_count` absent from all recent runs). Deploy it (dedup the batch by conflict key before upsert; verify byte-identical EV). Also blocked by unset `PINNACLE_PACK_EV_GATE_KEY`. Off-limits to autonomous (pack-EV route logic + edge deploy).
4. **Disk-IO saturation is the standing platform constraint.** The 2 GB Small instance throttles to ~22 MB/s when burst credits deplete, and the wave of MV-refresh/aggregation timeouts above is the recurring symptom. The levers are code/CC (the #1/#2 disk readers jobid 302/303 wmc-FMV pair — an 08-14 CC session already re-scoped jobid 302's cron arg 2:13→3.5s and dropped a 72 MB unused index) or a tier decision — both off-limits to this pass. No new autonomous lever tonight.
5. **topshot-active-listings-ingest egress_blocked** — deploy `atlas-proxy` (`wrangler deploy`, operator) + probe Cloudflare→Atlas egress, then wire the runner. Inert pending operator.

## Method notes
- Real-time check: shell `date` unavailable, so time established from DB `now()` (08:05Z) corroborated by fresh app rows (FMV `computed_at` 08:02Z — cannot be future-stamped). 08:05Z = 01:05 PT = inside overnight window, no skew.
- Avoided heavy queries under saturation: `rpc_ops_snapshot()` and any `max(sales.ingested_at)` scan time out (no `ingested_at` index), so used per-leg security/alert checks + the cheap `rpc_trust_health_precompute` reads instead.
- `check_pgcron_recent_failures()` is a set-returning function; wrapping the health vector in `json_build_object` fanned it to one row per pg_cron failure — read accordingly.

## Outputs (mount, UNPUSHED)
- `docs/handoff-2026-08-15-overnight-pass.md` (this file)
- `docs/overnight/metrics-latest.json`
- Ledger + inbox-archive: NOT written — both need git (append-at-top splice mount-only against an origin that a concurrent CC session advanced ~15 commits tonight is the "destroyed revert path" hazard CLAUDE.md warns of, and nothing shipped this run needs a revert-path ledger entry). Deferred until the shell/push is restored.
