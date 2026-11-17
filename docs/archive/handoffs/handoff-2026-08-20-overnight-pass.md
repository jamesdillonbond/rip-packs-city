# Overnight pass handoff — 2026-08-20 (~01:09 PT)

> ⚠ **Scope of the git-push blocker: it is specific to THIS cloud/desktop Cowork session.** `remote.origin.pushurl` is absent, so the sandbox has no push credential (`git push --dry-run` → `fatal: could not read Username for 'https://github.com'`). **Trevor's local box and Claude Code push normally via the PAT in `remote.origin.pushurl` — commit these output files as usual.** An environment limitation is a fact about the environment, never about the artifact. This run made NO DB or code changes, so there is nothing uncommitted-and-applied to worry about.

**Mode:** NO-PUSH nightly, genuine overnight window (01:04–01:12 PT confirmed from DB `now()`, not the prompt clock). **Ship budget used: 0 of 4. A quiet, honest night.**

## Verdict

Health GREEN / all-known-class under an **active severe saturation spell** (positive control io_wait **24/27**, 24 backends long-running >5s; `rpc_ops_snapshot()` timed out twice this run). Security 4/4 clean. Nothing was clearly-safe to ship during the spell, and the one genuine candidate (ccm MV staleness) carries a TRUNCATE-then-rebuild that could empty a public board if it times out mid-spell — so it is queued for a quiet window, not run tonight.

## What was reviewed

- **Continuity:** CLAUDE.md rules, `docs/overnight/ledger.md` top matter, `focus.md` (accuracy-gate phase; prefer NO-PUSH-friendly DB/artifact work; do NOT open new saturation-symptom investigations; do NOT archive inbox files — they are permanent citation targets; capture WAU), `metrics-latest.json` (last run), and all daytime-monitor inbox files since the last pass (`2026-08-19T1511Z`, `2026-08-19T2107Z`, `2026-08-20T0012Z`, `2026-08-20T0306Z`).
- **Inbox archival:** deliberately NOT performed — per `focus.md`, inbox files are permanent citation targets (referenced by exact path from CLAUDE.md, ledger, migrations, and live source `lib/analytics/rpc-with-retry.ts`). Treat as append-only.

## Health-drift findings (Section 2)

- **Saturation spell active NOW** — io_wait 24/27 at 08:07Z, a strict majority. Intraday series (from daytime ticks) shows the spell is intermittent within the day: cleared ~17:12 PT (0/0), re-appeared ~20:06 PT (16/16), severe again overnight (24/27). Per `focus.md §3` this is ONE root cause (disk-IO budget on the SMALL instance); NOT re-investigated. Lever is cutting work (page size / precompute / fan-out), never raising a timeout or the tier.
- **Security 4/4 clean** — directly re-measured: `rls_off_public=0`, `anon_authenticated_write_holes=0`, `secdef_anon_exec_drift` len 0. Nothing deployed since last clean read (push credential-less) so drift is structurally near-impossible.
- **Trust: 4/19 breached, all known-class.** Diffed the SET, not the count: `board_mv_refresh_stale_hours` 8.03 (marginal, 0.03 over), `fmv_sweep_wedge_hours` 7.24 (fmv-recalc saturation), `public_board_slow_count` 6, `unmapped_resolution_backlog_max` 338 (AllDay permanent floor, do-not-raise). **Cleared since last night: `topshot_impossible_parallel_serials`** (6→3→now under breach — the only genuine data-drift arm, self-heal cron working) and `fmv_sweep_stall_pct_24h`. Newly breached: the two saturation arms above (same fmv-recalc root as the cleared stall arm).
- **Demand: 21 users / 1 WAU (7d sign-ins), UNMOVED.** Directly re-captured from `auth.users`. Roadmap gate 50+ WAU.
- **Sentry / Vercel / pg_cron / stalled pipelines:** not independently re-queried this run (each stacks IO onto the active spell, and nothing has deployed since 08-18 so no new crash/deploy surface exists). Carried from the 0306Z quiet-ish tick: Sentry 0 new, Vercel latest READY `fdf84ee4` with 0 unresolved ERROR, pg_cron 5 fails all timeout-class/zero logic errors, 3 stalled all known-class.

## Post-ship watch (previous ships)

- **Aug-18 `reconcile-saved-wallet-stats` (autovacuum tuning) — REGRESSING, but NOT a ship fault; NO auto-revert.** The 08-18 fix (VACUUM + `autovacuum_*_scale_factor` on `wallet_moments_cache`) took per-wallet reconcile 9.3s→0.8s in a quiet window and predicted the backlog would "clear over the next few hourly runs." Two days on, `oldest_cache_h` has **climbed 212h → 267h**, and the last 3 runs are `ok=false` `soft_deadline_reached_partial_sweep_committed` with `wallets_done=1`, elapsed 69–115s. **Attribution: saturation throttling per-wallet cost, not the autovacuum change** — the tuning is still in place and beneficial; reverting it would make this strictly worse. So this is NOT a revert trigger; it is queued for a quiet-window re-measure and the deferred covering index (below).
- **Aug-18 `backfill-wmc-fmv-confidence` (jobid 302 rotation) and `get_fmv_coverage` single-probe** — no regression signal; not re-measured under the spell; last night PASS and no deploys since.

## Shipped

None. (Ship budget 0/4 used.)

## Needs your decision (QUEUED)

**1. NEW — Cross-collection MV refresh has failed 3 consecutive nightly cycles (~76h stale).** `cross_collection_cohort_mat` / `cross_collection_ts_set_overlap_mat` are stuck at 08-17 04:10Z/04:25Z; the 08-18, 08-19, and 08-20 04:10Z `rpc-ccm-step1`/`step2` cron ticks all timed out under saturation. Cohort count stable at 179 → **read-only freshness miss on `/insights/cross-collection`, NO data loss.** First filed as `2026-08-19T1511Z` CANDIDATE 1, re-confirmed by the 0012Z and 0306Z ticks and directly again this run.
   - **Why not auto-shipped:** `refresh_cross_collection_cohort_step1` opens with `TRUNCATE` (ACCESS EXCLUSIVE on a table the public board reads). During the active spell the step function times out (~105s probe against the `cron_heavy` 600s ceiling; its own 180s proconfig is inert), and a rebuild that times out **after** the TRUNCATE leaves the board empty — an availability regression on a live public surface. Not worth that risk for a 1-WAU freshness miss.
   - **Ready recovery (quiet window only — io_wait low, spell clear):** schedule a self-cleaning one-shot pg_cron job per failed step during genuine low traffic (body ends in `cron.unschedule` of itself). A FAILED one-shot does not self-unschedule and must be cleaned the next day. Do NOT run mid-day or mid-spell; do NOT manually `TRUNCATE`+rebuild. Underlying durable lever remains cutting the step's work, not raising its timeout.

**2. NEW — `reconcile-saved-wallet-stats` backlog is not clearing (oldest_cache_h 212h→267h over 2 days).** See post-ship watch above. Read-only staleness of saved-wallet dashboard/profile/share cards; no correctness/security impact.
   - **Ready lever (quiet window):** re-measure per-wallet reconcile cost in an uncontended window; if a whale wallet is the tail, build the deferred covering index `wallet_moments_cache (wallet_address, collection_id) INCLUDE (fmv_usd, tier)` via standalone `CREATE INDEX CONCURRENTLY` (makes the `top_tier` subplan index-only). The 08-18 ledger deferred it as marginal at 0.8s/wallet — but at 267h backlog and repeated soft-deadline truncation, it is now worth re-costing. Not shipped tonight: a `CREATE INDEX CONCURRENTLY` build during an active saturation spell is exactly what the ledger warns against.

**Long-standing (unchanged, one-liners):**

- Still queued — pack-EV `compute_pack_ev_per_edition_weighted` lateral `fmv_current` rewrite (~3,100× buffers, verified equivalent; blocked on a pinned-fixture re-seed = Trevor's call).
- Still queued — `drain_fmv_cold_tail` unscoped aggregate (re-measure buffers at a quiet hour).
- Still queued (operator-only) — sports-proxy 403 (two causes, not a secret); atlas-proxy `wrangler deploy`; the six "de-hardcoded" gate fns never redeployed (do NOT rotate their keys until redeployed).

## Failed / blocked / reverted

None. No verification failures (nothing shipped). No reverts.

## Files written this run (NO-PUSH — mirrored to the mount, uncommitted)

- `docs/handoff-2026-08-20-overnight-pass.md` (this file)
- `docs/overnight/metrics-latest.json` (overwritten with tonight's values)
- `docs/overnight/ledger.md` (one post-ship-watch entry prepended)
- `docs/sessions/2026-08.md` (session entry prepended)
- `docs/overnight/.lock` marked RELEASED
