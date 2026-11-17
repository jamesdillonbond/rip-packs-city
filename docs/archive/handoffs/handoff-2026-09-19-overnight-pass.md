# Handoff — RPC nightly autonomous pass — 2026-09-19 (~01:10 AM PT)

> ⚠ **Scope line (per skill §0):** This pass ran PUSH-CAPABLE in a Cowork **cloud** session; the `.rpc-git-cred` store helper authenticated (`git push --dry-run` exit 0). Any git limitation noted anywhere is specific to a given cloud session — **Trevor's machine and Claude Code push normally via Git Credential Manager. Commit as usual.**

Run-id `np-20260919-sbx`. Lock taken (prior lock was RELEASED, 09-18 monitor-only). No FREEZE. Real time confirmed from DB (`now()` 08:02:54Z == shell 08:02:25Z — clock NOT skewed; local 01:02 AM PT, genuine overnight window).

## Verdict: HEALTHY-UNDER-LOAD — nothing shipped (a quiet honest night)

The platform is functionally healthy. It is also in its ordinary evening/night **IO-contention** steady state, which produces the chronic read-timeout cluster on heavy user surfaces. This is exactly the "sweep ok ≠ lanes ok" state the 06:11Z daytime monitor pre-warned — **not a new regression.** The two live levers (atlas sync, cohort lane) were already shipped by the 09-18 evening concurrent session with pre-fired falsifiers and are **not mine to re-derive**; the one clean-looking cleanup (portfolios revoke) is defence-in-depth its own filing said not to ship unattended, and would add a schema-cache 500 burst under tonight's load. So: **0 shipped, 0 reverted.**

## Health-drift sweep

- **Security 4/4 clean:** RLS-off public tables **0**; anon/authenticated write-holes on RLS-off tables **0**; `check_public_security_invariants()` `[]`; secdef-anon `[]`.
- **Engine ACTIVE + writing** (splits engine from path): `max(sales.ingested_at)` 07:56Z, `max(fmv_snapshots.computed_at)` 07:56Z — ~6 min before the read. The 09-18 read-availability event (owed positive control from the prior lock) is **self-cleared for external clients** — I (an external MCP client) read and the pipelines are writing.
- **IO positive control (pg_stat_activity, client backends):** io_wait 6 / active 7 / total 24 / one long txn at 212s @ 08:02Z. Moderate, bouncing — the evening steady state, matching the 06:11Z monitor's io_wait 4↔11.
- **`rpc_ops_snapshot()` TIMED OUT at statement 1** under this contention (expected under load — the instrument itself is a heavy reader; dropped to cheap individual checks).
- **detect_stalled_pipelines(): 0** (improved from the 06:11Z read where the atlas lane showed at silent_minutes 71).
- **Trust precompute FRESH** (FMV metrics captured 07:50Z) → arms are trustworthy, no stale-refresher artifact. FMV high/med share: topshot **43.9**, allday **30.1**, candy **60.8**, pinnacle **27.5**, golazos **0.7**, ufc **0.0** (last two documented market-limited). fresh24h: topshot 54.3, allday 51.3, candy 61.3, golazos 3.1. topshot share leg (43.9) sits below its ~53 mean — a leg dip within the known bounce and/or the filed ask-corroboration-stamp item (0130Z); READ THE SERIES, not this leg.
- **Vercel runtime error groups (24h) — the real public-page instrument:** 50 groups, **14 live today / 36 stale (09-18 outage tail, last-seen ~18:59-21:45Z, now behind us).** Sentry dark by design (#34), so Vercel is the discriminator. **All 14 live groups are CHRONIC** (first-seen weeks/months old — pack-detail panels 08-23, edition market_bundle 07-12, insights/squeeze 08-16, Vercel-300s-timeout 06-16, api/market 09-13). **None new in the last 24-48h → last night's ships introduced no new error class.** The live cluster is the read-timeout / statement-timeout signature (pack-detail 8 panels, edition market_bundle, insights/squeeze, api/market) — the standing IO-capacity theme, amplified by tonight's saturation.
- **db_size 29 GB; editions 21,424.**
- **Artifacts:** manifest intact (11 items), none flagged broken in the inbox, data layer verified green — fresh-on-open, no drift → no repair warranted (per the "don't regenerate working artifacts" rule; the HTML lives outside this session's connected folders anyway).

## Post-ship regression watch (previous ~24-48h)

- **Atlas sync `*/6` back-off** (jobid 466, migration `20260919064000`): **PARTIAL RECOVERY.** `ts_listings` staleness 71.8 min (06:11Z) → **21.5 min**; last 6 ticks succeeded@07:42, @07:48, @07:55 then failed@08:02, @08:08, @08:14 — intermittent success, no longer 100% dead. The pre-fired falsifier (still ~100% failure 2h after apply) is **NOT tripped**. No revert warranted; the 00:45 PT scheduled task `trig_013cySF1yhVjqeaLb32GSn5Y` is the proper-bound test.
- **Cohort reschedule** (step1 `2 10`, step2 `35 10` UTC): **not yet fired** — last step1 run was 09-18 23:10Z (old time). Next runs 10:02Z/10:35Z (3:02/3:35 AM PT). Its falsifier is pre-fired twice over (step1 needs ~27 min on an IDLE box vs a 600s ceiling — visibility-map rot on `wallet_moments_cache`). **Re-check next pass; do NOT credit the move with a recovery when the lane simply relocates.**
- **Code ships** (packs holdings sync 1987b39d/71a3e35b, R96/R98 anon bounds, R107 edition_fmv_current fix, retention job 512): **no attributable new Vercel error class** → clean.

## Queued — needs a calm window or Trevor's call (nothing new is auto-shippable)

1. **`portfolios` anon write-grant revoke (defence-in-depth cleanup).** Filed 2026-09-19T0117Z. The anon write-grant set is exactly 5 objects; four are deliberate bounded telemetry/signup surfaces, the fifth — `portfolios` — is dead residue (0 rows, zero repo refs, neutralised-by-accident via a `wallet` JWT claim nothing sets, so it already fails closed). **Verified this pass:** `portfolios` owner = `postgres`; `snapshot_all_user_portfolios()` is SECURITY DEFINER owned by `postgres`; jobid 490 (`rpc-portfolio-snapshot-retry`) runs as postgres and writes `portfolio_snapshots` (not `portfolios`). So the revoke is a confirmed **no-op for the live lane** (owner keeps all privileges). Ready-to-run:
   ```sql
   -- migration: revoke_dead_portfolios_anon_write
   REVOKE INSERT, UPDATE, DELETE ON public.portfolios FROM PUBLIC, anon, authenticated;
   ```
   **Not auto-shipped because:** (a) it is defence-in-depth, not a live hole (its own deep-audit filing explicitly said don't ship unattended on a Friday evening); (b) a REVOKE triggers a ~10-20s PostgREST schema-cache 500 burst — under tonight's IO pressure, on user surfaces already read-timing-out, that is not net-positive. **Exit condition:** anon write-grant set reads **4**, all INSERT-only, and jobid 490's next tick still writes a `portfolio_snapshots` row. **Falsifier:** jobid 490 logs a permission error or `portfolio_snapshots` stops growing. Revert: `GRANT INSERT, UPDATE, DELETE ON public.portfolios TO ...` (re-grant). *(Alternative (b): retire `portfolios` + `portfolio_moments` + the dead ref in `snapshot_all_user_portfolios()` together — Trevor decision, destructive.)*

2. **`cross_collection_cohort_stale_hours` trust-health arm** (breach_at ≈ 26). OWED item #2 from the 0310Z monitor. Not auto-shipped: the arms live in a single ~50 KB `UNION ALL` inside `v_rpc_trust_health`, so adding one is a full-body `CREATE OR REPLACE` of the platform's trust surface — not an unsupervised change. Warranted (53.5h of cohort staleness passed with nothing alarming).

3. **R108 partial index build** (`idx_tame_nfl_nft_seen` on `topshot_atlas_market_events`). The inert `indisvalid=false` catalog entry from the 09-18 attempt is still present. The recipe (drop CONCURRENTLY then create, as postgres, at an odd minute) requires a **genuinely quiet window (Atlas tick durations under ~40s)** — **precondition NOT met tonight** (io_wait 6, Atlas at its 120s ceiling). Left for a quiet window, per its ledger row.

4. **The user-facing read-timeout cluster** (pack-detail panels, edition market_bundle, insights/squeeze, api/market). Standing IO-capacity theme; the root cause under active investigation is visibility-map rot on `wallet_moments_cache` (UPDATE-in-place churn + minutes-long open transactions defeat the hourly autovacuum). Fixing the surfaces = route/RPC/query work = OFF-LIMITS for autonomous shipping → `rpc-handoff` when a fix is designed. Extensively filed already; no new action.

5. **Inbox backlog hygiene:** `docs/overnight/inbox/` holds **523 un-archived files back to 2026-08-09**. Archival has lapsed across recent passes. Not bulk-archived tonight (INDEX.md carries CI assertions per autonomous-tasks.md, and the concurrent session actively references these) — flagged for a deliberate hygiene pass with the INDEX assertions in view.

6. **Periodic `cron.job` census** (0117Z): job population grew 104→149 in 16 days with no snapshot to diff membership. Wants a deliberate owner; not built here.

## Failed / blocked / reverted

None. No shipping was attempted, so no verification-failure hard-stop was triggered.
