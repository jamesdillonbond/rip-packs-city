# Overnight autonomous pass — 2026-07-14

**Mode:** GENUINE OVERNIGHT (~01:03 PDT). No clock skew (shell 08:02:32Z ≈ DB `now()` 08:02:42Z ≈ newest sale 07:52Z ≈ newest fmv 07:51Z, within ~10 min). Push AVAILABLE, no FREEZE. **Bash/git sandbox UP tonight** — a recovery from the 07-12 + 07-13 two-night `useradd exit 12` provisioning failure that forced NO-PUSH for code. Clone `$HOME/rpcwork` on `main`, pushurl token wired.

**Outcome:** Shipped **0** (deliberate — see rationale), reverted 0, repaired 0, closed 0. Drained 1 inbox file. A quiet, honest, fully-capable night whose value was the independent post-ship watch of the very heavy 07-14 daytime wave + health verification. origin/main `b227eec3` unchanged start→end.

---

## Why ship 0 (deliberate, not tooling-constrained)

Unlike the last two nights, all tooling was live tonight — I *could* have shipped. I chose not to because:

1. **The only NEW candidate (challenge `ends_at` filter) is a hot, actively-iterated file.** `get_active_challenges` was redefined by migration `20260714010000` (commit `9a27d276`) earlier today, and Trevor shipped 4+ challenge commits on 07-14 (`d455cd8f`, `9a27d276`, `f09eecee`, `fc265182`). The inbox candidate itself flags "if Trevor is mid-iteration on the challenge RPCs, defer." Collision rule → QUEUE.
2. **Systemic DISK-IOPS-THROTTLE says REDUCE load, not add it.** The 07-14 full audit diagnosed the whole overnight statement-timeout family as disk I/O burst starvation, with the explicit lever "stop recurring REINDEX experiments, let the burst refill, keep reducing read volume." Shipping any new index build or backfill tonight would compete for the exact IOPS burst that needs to refill — actively counterproductive. Every other queued candidate (82 art-less thumbnails one-shot GQL fill, etc.) adds read/ingest load.
3. Everything else in the queue is operator / CC-owned / gated.

## Reviewed

- **Continuity:** ledger (full, incl. Declined), today's inbox (`2026-07-14T0606Z.md`), focus.md (2026-06-24 studio-platform steer, still current), metrics-latest.json (07-13), the two 07-14 ledger sessions (Cowork full-audit + CC pinnacle-render passthrough).
- **Inbox drained (1):** `2026-07-14T0606Z.md` → archive.
- **Artifacts:** 16 in manifest, none flagged broken. Monitor already verified the challenge-ROI + pack-EV artifact backing views return rows after Trevor's 07-13 `security_invoker` flip. No repair needed (working artifacts are not regenerated).

## Health-drift triage — GREEN

- **Security 0/0/0/0** — invariants / secdef_anon [] / rls_off_base [] / anon_write_holes [] (live 08:03Z, via `rpc_ops_snapshot`).
- **Trust health:** 16 metrics, **breaches []** — all ok. impossible_parallel 1/3, unmapped_resolution_backlog 36/100, edition_integrity 4/50, topshot_fmv_stale 0.2h (fresh), pinnacle_fmv_stale 21.9/30.
- **stalled_pipelines []**, **pipeline_alerts []**, sentinel TS-UUID-48h **0**.
- **DB 8,166 MB** — down **~2,878 MB** vs 07-13 (11,044). The 07-12→07-13 climb to ~11 GB has fully reclaimed (wmc autovacuum + the ox3-wave trim churn settling). DB-SIZE-CREEP stays downgraded/noted-stable; the reclaim continued.
- **Editions:** TS **19,284** (+43 vs 19,241 = ongoing `::` subedition cataloging; sentinel 0 confirms no hyphen-UUID leak) / AllDay 6,190 / Golazos 575 / UFC 518.
- **FMV latest-per-edition:** TS HIGH 1,409 + MED 3,812 = **5,221 H+M** (+27 vs 5,194, improving) / AllDay HIGH 208 + MED 605 = **813** (+7) / UFC 15 / Golazos 4.
- **pipeline_fails_24h:** analytics-smoke 28 (top; `/api/admin/analytics-smoke` heavy-RPC contention timeouts — distinct from the smoke-test `034e7cdd` fixed), wallet-username-resolver 18, lock-check-batch 16, fmv-recalc 14, compute-topshot-pack-ev 12, alerts-dispatch 9 — all known contention family, all with recent OK runs.
- **pg_cron:** 4 jobs with overnight-window timeouts — `rpc-allday-resolve-rip-dist-api` (2, job startup timeout), `rpc-backfill-pinnacle-mint-acquisitions` (2, job startup timeout), `rpc-allday-ev-corrected-refresh` (1, job startup timeout), `rpc-attribute-pack-rips-empirical` (1, statement timeout 03:10Z). All the DISK-IOPS-THROTTLE overnight class; self-recovering (runs_in_window 24/4). No post-fix regressions.
- **Sentry:** 0 new unresolved (is:new, production, 24h).
- **Vercel:** prod `034e7cdd` (dpl_AAk3w71voQjY34NHR9ebo1qzfijc) READY. Runtime errors 24h are entirely the pre-existing contention family (statement/connection-pool timeouts clustered ~05:20Z overnight window); every group's `first` date is weeks/months old — **no new error signature from the 07-14 wave**. The monitor's `b227eec3` deploy CANCELED = docs-only inbox push, correctly not deployed.

## Post-ship watch — 07-14 daytime CC/Trevor wave: ALL PASS, 0 reverts

The 07-14 wave was very heavy: full audit + pack-page perf (`034e7cdd`), challenge airdrop-adjusted netEv RPCs, trophy-PDF v6/v7 (~15 commits), pinnacle-proxy render passthrough (`bb56cae5`), gift self-custody connect (`a8fd7cc6`).

- **`034e7cdd` per-dist pack market RPC + contention-404 fix — PASS.** `get_pack_market_row(text,text)` present + executes; `check_secdef_anon_execute_violations()` []. The old `[pack-detail] pack_market error (nba-top-shot)` timeout group (count 45) now has `lastDeployment=dpl_DQ379` (the *older* pre-`034e7cdd` deploy) — i.e. it stopped firing after the RPC deploy went live. Smoke "Sales History=false" for pack dist pages recovered to OK by 06:43Z; residual analytics-smoke fails are the *separate* heavy analytics-smoke RPC in the IOPS window, not the pack-page path.
- **Challenge airdrop-netEv RPCs — PASS.** `get_active_challenges` healthy: returns its single jsonb envelope, `activeCount` 31, ORDER BY the airdrop-adjusted net. No new error/Sentry issue. (See queued item re: the `ends_at` display gap — a display nuance, not a regression.)
- **Trophy-PDF v6/v7 + pinnacle-proxy code + gift connect — PASS.** No new Sentry issue, no new runtime-error signature on `/api/profile/trophy-case/pdf` or the pinnacle surfaces. pinnacle-proxy `GET /render` is worker code only (needs `wrangler deploy` — operator), zero prod impact.
- **Security 0/0/0/0 after all 07-14 migrations.**

## Shipped

None.

## Queued

### NEW — `get_active_challenges` shows just-expired challenges as active (LOW, cosmetic; night-count 1)
- **From:** daytime monitor inbox `2026-07-14T0606Z.md`. Verified live: `challenges` has 31 `status='active'`, of which **21 unexpired** (`ends_at > now()`) and **10 already past `ends_at`** (2026-07-14 03:00Z). The `ch` CTE in `get_active_challenges` (and the twin in `get_challenge_plan`) is `WHERE collection_id=<TS> AND status='active'` with **no `ends_at` guard** (the `ends_at` reference in the fn is only in the output payload + ORDER BY, not a filter), so `activeCount` reports 31 and the challenges tab / `rpc-set-challenge-roi` artifact show ~10 expired challenges for the ~5h daily window until the 08:10Z status re-sync. Self-heals every morning; `endsAt` is already in the payload so no info is lost.
- **Ready fix (DB, one migration):** add `AND (ends_at IS NULL OR ends_at > now())` to the `ch` CTE in `get_active_challenges` **and** `get_challenge_plan`. SECDEF, service_role/authenticated grants unchanged — pure filter tighten. Revert = restore prior defs from `20260714010000` / `20260714011000`.
- **WHY not auto-shipped:** `get_active_challenges` was redefined by `20260714010000` (commit `9a27d276`) **within the last 24h**, and the challenge RPCs are an actively-iterated surface (4+ challenge commits on 07-14). Collision rule + the inbox's own "defer if mid-iteration" caveat → QUEUE for Trevor/CC. Not urgent (cosmetic, self-heals daily).

### Carried (from ledger — unchanged, all operator/CC/gated)
- **TOPSHOT-ACTIVE-LISTINGS-ATLAS-BLOCK** (operator) — GHA active-listings ingest 403'd by Atlas datacenter block since 07-13 ~10:31Z; lanes = home-machine Task Scheduler ingest or browser-harvest. Underpriced-#1s board asks stale.
- **ownership-sync-dune** weekly tick failed 07-13 11:45Z (pool timeout); `topshot_ownership` stale until 07-19 unless CC retriggers `/api/cron/ownership-sync-dune`.
- **wmc index drop candidates** (`wmc_wallet_moment_unique_idx` 100 MB / `idx_wmc_lower_wallet_coll_edkey`) — deliberate CC/Trevor pass, not autonomous (UNIQUE invariant / planner check needed).
- **TS thumbnails: 82 actively-trading base editions art-less** — candidate one-shot GQL fill via topshot-proxy for the ~250 recent; deferred tonight (adding a GQL sweep during IOPS starvation is the wrong lever).
- **DISK-IOPS-THROTTLE** (systemic, operator) — overnight statement-timeout family; lever = let burst refill / reduce read volume; hard fix = temporary compute bump (cost-gated, Trevor's call) only if it persists ≥48h.
- Standing families: SMOKE false-fails, TOPSHOT-MOMENTS-HYDRATOR-GETMINTEDMOMENT-ERRORS, ALLDAY-PACK-OPENS-BACKFILL-404, cron-job.org dropout family, BUYERBF, and the standing owned/operator/gated queue + CC-owned full-audit-followups.

## Failed / blocked / auto-reverted

None. No shipping attempted, so no hard-stop triggered.
