# Overnight autonomous pass — 2026-07-13

**Mode:** GENUINE OVERNIGHT (~01:03 PDT). DB `now()` 08:03:32Z ≈ newest sale 08:03:06Z ≈ newest FMV 07:57Z — **no clock skew** (DB/app time authoritative; shell clock unavailable this run anyway).

**⚠️ ENVIRONMENT DEGRADED — BASH/GIT SANDBOX DOWN (2nd consecutive night), NO-PUSH FOR CODE.** The sandbox VM failed to provision on every attempt (`useradd: cannot create directory /sessions/cool-epic-meitner`, exit 12 — same class as 07-12). That removes **all** git capability: no per-run clone AND no mount-git fallback (the fallback also needs bash). Per Section 0/5 this forces NO-PUSH mode — **code commits and Vercel deploys are impossible this run.** Also degraded: the **Glob** tool (depends on the down sandbox mount → returns nothing). STILL LIVE: Supabase (DB migrations + health), Sentry, Vercel MCP connectors; the **Read / Write / Edit / Grep** file tools operate directly on the Windows mount. Health triage + post-ship watch ran in full; these output docs are written to the **mounted tree only (unpushed)** — a future run or Trevor picks them up.

**Result:** **Shipped 0** (correct). Reverted 0, repaired 0, closed 0. A quiet, honest, GREEN night, tooling-constrained. No compelling low-risk DB-only ship candidate existed, and code work was impossible regardless. The pass's value this run was the independent health verification + the post-ship regression watch on today's heavy Claude Code wave.

## Gates
- **Lock:** was RELEASED (07-12 run). Took it (HELD marker), released at end.
- **FREEZE:** absent.
- **Quiet-hours:** genuine overnight, no skew (DB/app time authoritative).
- **Push capability:** UNAVAILABLE (bash/git down) → NO-PUSH mode for code; DB + MCP + mount writes only.
- **Collision context:** heavy Claude Code + Trevor activity on `main` **today** (multiple 07-13 interactive sessions — see ledger). Last push was ~04:00Z (~4h before this run; the 3 newest commits are docs-only, CANCELED) so `origin/main` is **not** actively advancing right now — but combined with no-push this keeps the run firmly queue-only for code.
- **Inbox:** empty. The 07-12 monitor files were drained by a Claude Code session earlier today (archived to `inbox/archive/`); no new monitor file is present (the daytime monitor also needs bash/git to push, which is down). Glob can't enumerate the mount this run, but no candidate files were readable.

## Health-drift triage — GREEN
Baseline from `rpc_ops_snapshot()` (08:06Z):
- **Security 0/0/0/0** — invariants / secdef_anon / rls_off_base / anon_write_holes all `[]`.
- **Trust health** — 16 metrics, breaches `[]`, all ok. `topshot_impossible_parallel_serials` **1**/3, `unmapped_resolution_backlog_max` 37/100, `edition_integrity_flags` 4/50, `fmv_sanity_flags` 0, `pinnacle_fmv_stale_hours` 22/30, `topshot_fmv_stale_hours` 0.2 (fresh), all per-collection FMV freshness within band.
- **sentinel_ts_uuid_editions_48h** 0 (no writer leak; the +31 TS editions are legit `::` subedition cataloging).
- **System is fully alive** — 78 distinct pipelines / 447 runs in the last 45 min, only 4 fails, newest run 08:08Z, newest sale 08:03Z. So the **two INFO `stalled_pipelines`** are isolated misses, NOT a cron dropout: `refresh-pack-grail-metrics-mv` (Vercel `:23` cron, missed the 07:23Z tick, self-heals at 08:23Z — powers grail ranking UI, freshness fine) and `topshot-moments-hydrator` (carried upstream `getMintedMoment` GQL class; enrichment only).
- **pg_cron** (`check_pgcron_recent_failures()`) — 4 jobs, ALL known contention-family timeouts in the overnight window, each with recent successes too: `rpc-remap-misattributed-sales` (stmt timeout, self-heals off-peak), `rpc-refresh-misattrib-candidates`, `rpc-refresh-special-serial-owners-mv` (carried REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT), and the new `rpc-backfill-pinnacle-mint-acquisitions` (1 `job startup timeout` / 7 runs — transient worker-slot contention; per focus/ledger, do NOT flag the new Pinnacle-mint pipelines). None are post-fix regressions.
- **Sentry** — 0 new unresolved issues (`is:new`, production, 24h).
- **Vercel** — prod HEAD `2d57889f` (challenges searchChallenges ingest scheduler) READY. The 3 newest commits (`8e895cba`/`d00dc1b5`/`779d5aed`, gifting docs) are **CANCELED and docs-only** — zero user impact; production behavior is identical whether or not they deploy.
- **pipeline_fails_24h** — all known families, none stalled: analytics-smoke 32 (smoke false-fails), wallet-username-resolver 30 (self-heals), lock-check-batch 29 (external upstream API timeout), fmv-recalc 14 (contention window; FMV stays fresh 0.2h so no user gap), topshot-buyer-backfill 12 (BUYERBF), compute-topshot-pack-ev 11, alerts-dispatch/run-insider-detectors/topshot-deal-floor-serials 9 each (the evening-contention cluster — see post-ship watch).

### Deltas vs 07-12 (metrics-latest.json)
- FMV TS H+M 5,205 → **5,194** (−11, re-bucket noise). AllDay 815 → 806. UFC 15 → 15. Golazos 4 → 4.
- editions TS 19,210 → **19,241** (+31, ongoing `::` subedition cataloging; sentinel 0 confirms no hyphen-UUID leak). AllDay 6,190 / Golazos 575 / UFC 518 flat.
- impossible_parallel 1 → 1. unmapped backlog 36 → 37. edition_integrity 4 → 4.
- pinnacle_fmv_stale 15.2h → 22h (within band). pinnacle_ask_stale 0.2 → 0.2.
- **DB 11,161 → 11,044 MB (−117)** — the +2 GB/day creep flagged 07-12 did **NOT** continue; wmc autovacuum reclaimed and total edged down. Confirms last night's "benign organic growth" read. DB-SIZE-CREEP downgraded from watch to noted-stable.

### Post-ship regression watch — ALL PASS, 0 reverts
Today's heavy Claude Code / Trevor wave on `main`, re-measured live:
- **`a0c50694` deal-board SECDEF RPC** (`get_topshot_deal_external_ids`, 90s proconfig) — `topshot-deal-floor-serials` **3 ok / 0 fail** last 3h (last run 07:37Z ok). The "deal board read: statement timeout" every-peak-run failure is gone. **PASS.**
- **`a0c50694` per-collection insider-detector split** — `run-insider-detectors` 1 ok / 1 fail last 3h (06:26Z fail is one collection's leg in the overnight window; the split's benefit is that a partial timeout no longer zeroes ALL alerts). Not a regression from the fix; residual contention is the environmental cluster whose real lever is operator de-peaking (#5). **PASS (watch).**
- **`c28bc331` fmv-recalc today-purge lock_timeout=25s SECDEF RPC** — fmv-recalc still takes contention-window fails (14/24h) but `topshot_fmv_stale_hours` 0.2 = fresh (successful ticks keep FMV current); no user gap. **PASS.**
- **CCM-step1 REINDEX fix** — `rpc-ccm-step1` last run 04:10Z **succeeded** (post-reindex ~54s, under the `cron_heavy` 600s ceiling); cohort surface fresh. **PASS.**
- **Pinnacle mint provenance pipelines** (`9c25030b` + jobs 83/84/85) — `pinnacle_mint_events` 6,420, newest 08:10Z (backfill cursor descending as designed); `moment_acquisitions` source `pinnacle_mints` 19 (the `:19` classify gap-fill). Writing correctly; deliberate one-time historical backfill — **not flagged** per ledger/focus. **PASS.**
- **Challenges VARIABLE-model rework** (`56152f47`/`d2acff6d`/`2d57889f`) — the Cowork `rpc-set-challenge-roi` artifact was migrated to `get_active_challenges(NULL, TS)` and verified healthy (returns a jsonb object with **31** challenge items). The old `v_set_challenge_roi` view no longer exists but the artifact no longer reads it, so nothing is broken. **PASS.**
- **Test-coverage push + architecture guards** (`903a2876`) — CI-only, no runtime prod surface. No-op for prod health. **PASS.**
- Security **0/0/0/0** after every migration in the wave. Sentry 0 new.

## Artifacts
16 in the manifest; none flagged broken (no inbox this run). Spot-verified the only one touching today's churned schema — `rpc-set-challenge-roi` — is HEALTHY (its `get_active_challenges(NULL,'95f28a17…')` query returns 31 items). The rest are stable June-era dashboards over long-stable RPCs/views (security 0/0/0/0, no tables dropped tonight). **0 repairs needed** — artifact data is fresh-on-open, so no regeneration for its own sake.

## Shipped
None.

## Queued / needs decision
- **BASH/GIT-SANDBOX-PROVISION-FAILURE (operator/infra — now 2nd consecutive night, escalating).** The Cowork sandbox VM would not boot 07-12 **and** 07-13 (`useradd` exit 12 on `/sessions/<name>`). This **removes the pass's ability to ship code** (clone + mount fallback both need bash) AND likely blocks the daytime monitor from pushing inbox files (same dependency), which is why the inbox is empty. DB/MCP/health work is unaffected. If it persists, the pass is permanently degraded to DB-only + read-only. **Operator: investigate Cowork sandbox / session-dir provisioning.**
- **WMC-INDEX-BLOAT-SECONDARY (LOW cleanup, night-count 2; carried from the 07-13 CC ledger entry).** `idx_wmc_lower_wallet_coll_edkey` = ~339 MB with only ~29 lifetime scans — both bloated AND near-unused. Candidate for `REINDEX INDEX CONCURRENTLY public.idx_wmc_lower_wallet_coll_edkey` (reclaim ~200 MB, behavior-preserving) OR `DROP INDEX` (needs planner-reliance verification first — near-unused ≠ unused). **Not auto-shipped:** it sits in the wmc-index area Claude Code was actively reworking today (CCM covering-index reindex), DB size is stable/down tonight (no bloat pressure), and REINDEX-vs-DROP needs the planner analysis a blind ship can't do. Owner/CC or a future non-degraded night.
- **Carried families (unchanged, all known / self-healing / owned-or-operator):** DB-SIZE-CREEP (downgraded — stabilized/−117 MB tonight); SMOKE false-fails; TOPSHOT-MOMENTS-HYDRATOR-GETMINTEDMOMENT-ERRORS (upstream GQL, no corruption); ALLDAY-PACK-OPENS-BACKFILL-404; FMV-RECALC contention family (improving-ish, FMV fresh); cron-job.org dropout family; evening HTTP-contention cluster (operator de-peak #5); REMAP / REFRESH-SPECIAL-SERIAL-OWNERS-MV / misattrib-candidates overnight-contention timeouts; BUYERBF; the standing owned/operator/gated queue; and the CC-owned full-audit follow-ups (home-machine Task Scheduler ingests, ALLDAY_PROXY_URL, VERCEL-CRON-MISATTRIB-DRAIN-500, UFC-Aptos UI).

## Failed / blocked / reverted
None failed or reverted. The only blocker is environmental: **git push unavailable (bash/git sandbox down)** → all code work queued for Trevor; these output docs are mount-only (unpushed).
