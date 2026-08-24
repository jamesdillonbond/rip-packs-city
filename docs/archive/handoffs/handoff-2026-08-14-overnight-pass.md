# Overnight autonomous pass — 2026-08-14 (OFF-HOURS 22:16 PT Aug 14; MONITOR-MODE + NO-PUSH)

*(Renamed from `handoff-2026-08-15-…` by Claude Code, 2026-08-14 22:40 PT: dated files here carry the **PT**
calendar date of the run, and this run's own body records 22:16 PT Aug 14. Precedent — the 08-13 off-hours
pass at 07:49 PT is `handoff-2026-08-13`. UTC-day references to pipeline data inside the file are left exactly
as written.)*

**Mode:** MONITOR-MODE + NO-PUSH. Shipped **0** / reverted **0** / repaired **0**. Two new health datapoints, both self-recovered/known; everything actionable is operator- or Claude-Code-owned and QUEUED.

## Why this mode
- **Real time:** DB `now()` = 2026-08-15 05:16Z = **22:16 PT Thu Aug 14**, corroborated by fresh app-stamped rows (`max(sales.ingested_at)` 05:12Z, `max(fmv_snapshots.computed_at)` 05:15Z) — no clock skew. 22:16 PT is **outside 00:00–06:00** → this run fired late (off-hours) → MONITOR-MODE (queue, don't ship; auto-revert of a regression still allowed).
- **NO-PUSH:** sandbox shell down (`/sessions` no-space, `useradd` exit 12), ~7th consecutive night. No shell → no clone → no git. Everything else GREEN: Supabase MCP (read), Vercel MCP, Sentry MCP, cowork artifacts, and direct file access to the mount. Outputs written to the MOUNT, **unpushed** — Trevor/Claude Code commit as usual.
- Concurrency lock was RELEASED (stale from 08-11); took over, held, will release on exit. FREEZE absent. focus.md is stale steer (06-24) with standing "do-not-re-flag" notes only.

## Health-drift triage (all measured live from `rpc_ops_snapshot()`)
- **Security: 4/4 CLEAN** — invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations all `[]`.
- **DB size:** 12,917 MB (12,833 at 08-14 03:12Z → +84 MB/~26h, normal growth).
- **Sentinel** TS-UUID editions 48h = 0. `fmv_sanity_flags` 0. `edition_integrity_flags` 94 (breach 250, ok). `trust_precompute_max_age_hours` 4.33 (breach 13, fresh). `board_mv_refresh_stale_hours` 1.29 (ok).
- **Trust breaches = 3, ALL known/tracked classes (no new breach):**
  1. `panini_sale_price_capture_dry_days` **17** (breach 3) — home-box Panini runner outage; operator-owned. `panini_fmv_stale_hours` 0.2 / `panini_coverage_pct_drop` 2 both ok, so FMV is fresh — only new-price *capture* is dry.
  2. `public_board_slow_count` **6** (breach 1) — saturation collateral, oscillating (16 on 08-11 → 1 on 08-14 03:12Z → 6 now). `public_board_empty_count` 0 → no board broken/empty.
  3. `unmapped_resolution_backlog_max` **254** (breach 100) — AllDay permanent-class floor; net-draining (inflow 127/24h < outflow 159/24h).
- **Sentry:** 0 new (firstSeen -24h) and 0 regressed (lastSeen -48h). Clean.
- **Vercel:** production on **`fda4ccf4`** (concierge find_quirky_serials fix) **READY**. The two newest commits (`ac15a9a6`, `b16c9f0d`) are docs-only and CANCELED — the expected `vercel.json` `ignoreCommand` skip for a docs-only diff, not a build failure. The last *code* deploy already shipped READY.

### Pipeline alerts
- **CRITICAL `pg_net_http_403`** — 23 pg_net-dispatched edge-fn calls returned 403 in 2h (`{"error":"forbidden"}`). Recurring **gate-key half-rotation outage** (already queued; runbook `inbox/2026-08-11T0300Z-gate-key-rotation-runbook.md`). Operator: complete the rotation as ONE window (8 `*_GATE_KEY` secrets → deploy env-var fns → repoint cron `?key=`). `check_edge_fn_http_failures()` reads `[]` once done.
- **HIGH `compute-pinnacle-pack-ev`** — 8/8 fail since 08-12; deterministic `upsert pack_distributions: ON CONFLICT DO UPDATE command cannot affect row a second time`; last OK 2026-08-11 06:17Z. **Confirmed NOT resolved** — the claimed fix `bd53bb3a` is absent from the last ~20 Vercel deploys (all trophy/cosmetic/seo/search/concierge/pack-detail/db/docs), so it never deployed or was ineffective. Fails identically in quiet + saturated windows → deterministic-collision class, not IO-saturation. Off-limits for autonomous ship (pack-EV route logic + edge deploy; also blocked by unset `PINNACLE_PACK_EV_GATE_KEY`). Bounded blast radius: Pinnacle pack-EV surface staleness (`pack_ev_board_max_stale_days` 1.42, still ok).
- **08-14 disk-IO saturation spell — self-recovered (post-ship-watch datapoint, no action).** `lock-check-batch` (08-14 13ok/34fail vs 08-15 10/1), `wallet-username-resolver` (6/40 vs 10/1), and `compute-topshot-pack-ev` (289/93 vs 97/6) all spiked on 08-14 with connection-pool / statement-timeout errors and **recovered on 08-15 (today)**. These are the documented Small-compute IO-budget class — NOT the ON CONFLICT class, NOT a logic defect, NOT attributable to any ship. `compute-topshot-pack-ev`'s errors are timeouts, not the pinnacle collision.
- **info** `candy-listings-indexer` cron_silent 463m (known no-op under ME quest-hold; candy_mlb board reads directly, not user-facing) and `unmapped-sales-nfl_all_day` growth (frozen multi-NFT txs by design).

## Post-ship regression watch — PASS, 0 reverts
Recent 24–48h shipping was Claude-Code interactive code work (trophy-pin confirm-before-overwrite, cosmetic-render gate, SEO byline/alt, proxy public-path pins for shareable profiles, search token-coverage fix, concierge quirky-serials wiring, pack-detail partition prune, unused-index drop). Evidence of no regression: Sentry 0 new / 0 regressed over 48h; production READY; the 08-14 pipeline spike self-recovered by 08-15. Nothing traces to a ship; nothing to revert.

> ⚠ **Follow-up correction (Claude Code, interactive, 2026-08-14 22:40 PT) — queued items 1 and 2 are both
> smaller than stated here, and one method above cannot work.**
> **(a)** The Vercel-deploy scan cannot answer whether `compute-pinnacle-pack-ev` shipped — it is a **Supabase
> edge function** and never appears in a Vercel deploy, so "absent" reads identically for a deployed fix, an
> undeployed one, and a function that does not exist. Re-measured with the fix's own telemetry
> (`extra ? 'dist_dupe_count'` — false on all 10 most recent runs): **never deployed**, *not* "ineffective".
> The verdict *do not close as resolved* stands; only the reasoning was unsound.
> **(b)** The `pg_net_http_403` CRITICAL is **one job** — jobid 16 `rpc-backfill-pack-pool`, attributed
> **71/0** by cron-minute set membership in both directions — not "a different subset of the 14", and it needs
> **one secret**, not an 8-secret window (dual-accept `_OLD` has made rotation per-job since `e66884f7`). Its
> blast radius is the frozen `gql_historical` pool lane only; the live `gql` pool refreshed 35,056 rows in 24 h.
> Full measurements, including why the "~1.6 h retention" figure that justified giving up on attribution is
> wrong: [`inbox/2026-08-15T0540Z-the-403-critical-is-one-job-and-the-pinnacle-deploy-question-is-closed.md`](overnight/inbox/2026-08-15T0540Z-the-403-critical-is-one-job-and-the-pinnacle-deploy-question-is-closed.md)

## Queued (nothing auto-shipped — MONITOR-MODE + NO-PUSH; all also operator-/CC-owned)
1. **`compute-pinnacle-pack-ev` deterministic ON CONFLICT — STILL FAILING (do NOT close as resolved).** CC/operator: dedup the batch by conflict key before `upsert pack_distributions` (keep-last) OR per-row upsert with 21000/23505 fallback; verify byte-identical EV; confirm it deploys READY and logs a fresh OK. Also set `PINNACLE_PACK_EV_GATE_KEY` (else deploy-alone 403s every tick — jobid 42 is a gate-keyed fn).
2. **`pg_net_http_403` gate-key rotation** (recurring CRITICAL). Operator: one-window rotation per the runbook.
3. **Standing operator items:** free the `/sessions` volume so the overnight shell/git works (blocked ~7 nights; `docs/handoff-2026-08-09-cowork-shell-recovery.md`); `atlas-proxy` + other pending `wrangler deploy`s (topshot-active-listings-ingest `egress_blocked` 9/11); the remaining gate-key rotation subset.
4. **Carry (self-healing / display-only):** `rpc-refresh-misattrib-candidates` single pg_cron statement-timeout (08-13 15:35Z, IO-heavy window; self-heals next quiet tick).

## Not done (mode/shell constraints)
- **Inbox NOT archived** (archival is a `git mv`; shell down) — ~40 files standing, expected. No new inbox file written this run (findings captured here + in metrics-latest.json).
- **Ledger NOT appended** — 0 shipped ⇒ no revert path to record, and NO-PUSH means an append wouldn't commit. Consistent with prior NO-PUSH nights.
- **Artifacts:** 11 present, none flagged broken; `public_board_empty_count` 0 confirms no board is schema-broken. Deep payload replay skipped (monitor-mode; no shell). Left untouched.

## Escalation
Sandbox shell has been down ~7 consecutive nights, blocking every overnight git push and the daytime-monitor's inbox archival. Operator action needed: delete old Cowork sessions to free `/sessions` (`docs/handoff-2026-08-09-cowork-shell-recovery.md`).
