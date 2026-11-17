# Overnight pass — 2026-07-31 (OFF-HOURS monitor-mode)

**Run:** rpc-nightly-autonomous-pass · night-20260731T154512Z · fired **15:45Z / 08:45 PDT**.
**Mode:** OFF-HOURS MONITOR-MODE — 08:45 PDT is outside the 00:00–06:00 window, so this run reviewed + triaged + ran the post-ship watch and **queued instead of shipping**. No clock skew (shell 15:44:37Z ≈ DB now() 15:44:51Z ≈ max sale 15:43Z ≈ max fmv 15:34Z — all agree within seconds).
**Gates:** prior lock RELEASED (07-29), no `docs/FREEZE.md`, push AVAILABLE (`git push --dry-run` up-to-date), clone `$HOME/rpcwork` on `main`. Took lock `night-20260731T154512Z`.
**origin/main:** `787fee10` at run start and unchanged at run end (an interactive Claude Code session had pushed through ~15:07Z — ~38 min before this run — but had stopped by run start).
**Shipped:** 0 (correct — off-hours; and no new shippable candidate existed regardless). **Reverted:** 0. **Repaired:** 0. **Inbox drained:** 0 (empty). **Connectors:** Supabase + Sentry + Vercel MCP live; bash/git/clone/push up; Cowork artifact tools available (not needed). No GitHub-Actions run-lister connected this session (CI green not independently re-verified — see Health note).

---

## Post-ship regression watch — last ~48h prod-affecting changes: ALL PASS, 0 reverts

| Change (commit) | Target | Result |
|---|---|---|
| FMV 1000-row-cap fix — widen `fmv_current` + swap 8 read paths (`71b04635` + migration `audit_20260730_widen_fmv_current_add_enrichment_cols`) | FMV coverage / deal detection | **PASS.** `fmv_current` = 26,773 rows = 26,773 distinct editions (1/edition — cannot hit the cap), `security_invoker=true`, `has_table_privilege('anon',…)` = false (no leak). Vercel READY. TS FMV HIGH+MED **2,958** (up from 2,860 on 07-28). |
| drain-conflated-subeditions unblock — materialize knot-seed CTE + bind split LIMIT to actionable rows (`cd775ec1`, 2 DB migrations) | nightly drain progress | **PASS.** Nightly run 07-30 20:30Z ok; `extra.split.wmc_split` = **8,125** (was 0/1/2 before the fix); `seeded` working; `conflated_editions_remaining` 795, draining. |
| `unmapped_resolution_backlog_max` 24h grace (`35aa7c3b`) | measure failure-to-resolve not latency | **PASS.** Metric reads **85**, status ok, breach_at 100 (was breaching at 106 pre-fix; read 62 right after). Not masking a stall (positive control preserved per the fix). |
| profile/teams IDOR write close + Sets hooks-crash (`dbabf575`) | security / crash | **PASS.** Vercel READY. 0 new Sentry issues in 48h. |
| analytics force-dynamic ×2 + confidenceDist SALES_ONLY (`009f08e7`) | prerender hazard / bucketing | **PASS.** Vercel READY. 0 new Sentry. |
| 07-31 CI/edge/component/docs (`b4c6f384`, `21301887`, `787fee10`) | CI green / test coverage | Test/CI/config/docs only — no prod-DB. Deploys READY or correctly CANCELED (docs-only). `b4c6f384` also repaired a real prod bug source (`scan-pinnacle-wallet` wmc write) — **redeploy-aware, not yet deployed** (no cron caller; operator/opportunistic `supabase functions deploy`). |

---

## Health-drift triage — GREEN

- **Security:** `rpc_ops_snapshot().security` all `[]` — invariants, anon_write_holes, rls_off_base_tables, secdef_anon_violations. `check_pgcron_recent_failures()` = `[]`.
- **Trust health:** 23 metrics, **0 breaches**. Notables (all ok): `unmapped_resolution_backlog_max` 85 (breach 100), `edition_integrity_flags` 94 (250), `topshot_fmv_pct_stale_30d` 32.3 (50), `ufc_fmv_pct_stale_30d` 96.1 (101 — thin market, structural), `topshot_fmv_stale_hours` 0.3 (6).
- **pipeline_alerts (3, all `info`):** (a) `panini-ingest` cron_silent — residential home-box 5th scheduler, last run 07-30 13:30Z (~26h silent); pre-launch (proxy-gated), known home-box-sleep pattern, watchlisted at 360 min/info — **raise severity at PANINI go-live, not before**; nothing autonomous can fix Trevor's home machine. (b) `ufc_sales` resolving_editions — known bridge-pending, 6/24h. (c) `unmapped_backlog_growth` nfl_all_day — 32,271 actionable rows, **net draining** (outflow 1,556 > inflow 271/24h), ~25d to clear, oldest 2026-01-23.
- **pipeline_fails_24h (36 total — all normal):** `topshot-active-listings-ingest` 7 `egress_blocked` **but latest run 15:32Z OK** (the standing GHA dropout item, symptom shifted from silent-dropout to egress_blocked-then-recover; sibling `topshot-listing-cache` healthy so live TS listing coverage intact). `wallet-backfill` family 6 each vs **455–456 OK** each (~1.3% — whale-collection Cadence `computation exceeds limit (100000)` on `getIDs()`, per-wallet pagination/dispatch hiccups; NOT systemic). Singletons: compute-topshot-pack-ev 2, backfill-pack-rip-metadata 1, allday-unmapped-resolver 1, topshot-misattrib-drain 1 — all normal.
- **Sentry:** 0 unresolved issues firstSeen in 48h.
- **Vercel:** prod READY, 0 ERROR-state across last 20 deploys; docs-only tips correctly CANCELED by `ignoreCommand`.
- **DB size:** 11,721 MB (07-28: 11,344 → +377, normal growth).

### Deltas vs metrics-latest (2026-07-28)
- DB 11,344 → **11,721 MB** (+377).
- TS FMV HIGH+MED 2,860 → **2,958** (+98).
- `unmapped_resolution_backlog_max`: was breaching 106 on 07-29 → **85 ok** post grace-fix.
- Editions: top_shot 19,531→**19,552**, all_day 6,190, golazos 575, ufc 518, candy_mlb 125.

---

## Shipped / Reverted / Repaired

None. Off-hours monitor-mode; and independently, no new low-risk shippable candidate existed — the only DB/health findings are either healthy-by-design, home-box-external, or already-queued off-limits/gated items.

---

## Queued (carried forward — none new-and-actionable this run)

1. **GHA-ACTIVE-LISTINGS-INGEST-DROPOUT** (queued 07-29, night 3) — **symptom update:** now firing but 7/24h runs error `egress_blocked` before recovering (latest 15:32Z OK), vs the earlier silent-scheduler-dropout. Medium / visibility-only (sibling `topshot-listing-cache` keeps live TS listing coverage). Fix options unchanged: backstop / widen threshold / accept. Not a low-risk DB/doc ship.
2. **07-29 deep-dive residuals** (queued 07-29) — sniper-feed "Badges only"/"Special serials" filters silently no-op on the live RPC path [HIGH, rework]; `/api/analytics` whale totals capped at 10k [MED, needs aggregate RPC]; `edition-floor` Flowty-leg-not-edition-scoped + persist-path corruption [MED, masked]; `best-offers` empty-editionKeys early-return, `pack-roi` dead, `wallet/save`+`export-csv` latent-IDOR-if-revived, FmvDashboard confidence mislabel [all LOW]. Flagship money-route reworks — each needs its own tested pass, not a session-tail rush.
3. **WMC-REALIGN-VS-WALLET-WALK-EDITION-KEY-LOOP** (queued 07-29) — 4 wmc rows re-realigned nightly because a wallet-walk write overwrites `edition_key` after the realign corrects it; trivial scale (4 rows), needs a wmc write-path change (ingest-adjacent, off-limits autonomous).
4. **edge-deno gate → blocking** (queued 07-30) — 21 residual `deno check` errors (import-resolution / version-strictness) need a deno-in-the-loop session; `deno check` is unverifiable from this proxy-blocked sandbox.
5. **scan-pinnacle-wallet redeploy** — `b4c6f384` fixed the wmc-write crash in source; needs a `supabase functions deploy scan-pinnacle-wallet` to reach the live fn (no cron caller; operator/opportunistic).

---

## Failed / blocked

None. No verification failure, no hard-stop (nothing was shipped). No auto-revert needed (post-ship watch clean).
