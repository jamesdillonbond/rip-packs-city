# RPC overnight autonomous pass — handoff 2026-08-29

**Mode: OFF-HOURS + NO-PUSH + QUEUE-ONLY. Shipped nothing. Post-ship watch clean. No auto-revert.**

- **Real time:** shell `date -u` 17:31:20Z == DB `now()` 17:31:33Z (no clock skew). `max(ingested_at)` 17:23Z / `max(computed_at)` 17:30Z bound real time from below. Real local ≈ **10:31 AM PDT → OFF-HOURS** (outside 00:00–06:00): the task fired late (daytime launch), so per Section 0.1 this ran in monitor-mode — full triage + post-ship watch, queue everything, ship nothing except a regression auto-revert (none needed).
- **Push:** `git push --dry-run` → `could not read Username` (mount carries only the unauthenticated URL; the desktop pushurl-with-PAT harvest is dead). NO-PUSH: DB migrations/artifact repairs would still be allowed, but off-hours monitor-mode queues those too. All output docs written to the **mount**, uncommitted.
- **Also:** `origin/main` advanced mid-run (`f8d8f90f` fix(deal-floor-serials) BUILDING at ~17:39Z) — a human/Claude Code is actively pushing. Independently forces queue-only (Section 5).
- **Lock:** taken over (prior lock RELEASED). Marked RELEASED at end.
- **FREEZE:** absent.

## Reviewed
- Ledger head, latest handoff (08-28), `metrics-latest.json` (08-28 NO-PUSH baseline), inbox (309 files clone / 305 mount — append-only by design, NOT archived).
- Fresh inbox since 08-28 night pass: most were **already addressed by today's daytime Claude Code commits** — `promote_unmapped_sales` guard (90510112 + 211b5329), `duration_ms` contamination (28def7c2/211b5329), R21 IO-waste ranking (769f21c1), `/insights/deals` stale-stamp diagnosis (a589c65e), Packs-column honesty (3d566bd2), username-resolver ok-predicate (8fd80727), deal-floor-serials ok-predicate (f8d8f90f, building).
- Mount-only monitor filings not yet folded into a commit: `2026-08-29T0308Z` thin-fmv-guard daily statement-timeout at 0830Z band tail; `T0420Z` underpriced board null-read range restriction; `T0425Z` jobid-211 three dead slots (saturation decay — deleting them burns the thermometer). All QUEUED below.

## Health-drift findings + deltas
- **Security:** clean — no RLS-off base tables, no anon/authenticated write holes on RLS-off tables, invariants + secdef_anon violations both `[]`.
- **Stalls (`detect_stalled_pipelines`):** 4 arms, all known/documented (weekly-db-maintenance info; panini-ingest info; allday-pack-opens-backfill medium EarlyDrop; refresh-pack-grail-metrics-mv info killed-ticks-logging-only n=2 positive control). None new.
- **Pipeline alerts (`get_pipeline_alerts`):** all known classes. HIGH: `snapshot-institutional-wallets` (57.1%, wmc OFFSET paging timeout — keyset fix queued), `topshot-pack-pool-backfill` (67.9%, 530/1033 legacy endpoint). MEDIUM: offers-sweep / topshot-moments-hydrator / topshot-fmv-populate / topshot-badge-set-backfill (all 530 legacy endpoint), topshot-active-listings-ingest (egress_blocked #20/#30), wallet-username-resolver (queue-fetch statement timeout). INFO: golazos_sales resolving, grail-mv cron_silent, unmapped nfl backlog, weekly-db-maintenance.
- **Top Shot LEGACY-endpoint outage — ONGOING ~24h+.** `public-api.nbatopshot.com` 530/1033 since ~18:00Z 08-28. Studio endpoint HEALTHY (`snapshot-pack-asks` 566/566 ok) — so the fault is the legacy endpoint only, not Dapper GraphQL. External; the actionable in-repo path (Studio-endpoint client migration) is NOT a find-and-replace and needs verification + push → queued.
- **Deltas vs 08-28:** editions 27,314 → **27,321** (+7 TS); db 14,064 → **14,327 MB** (+263). Normal growth. FMV HIGH+MED per-edition metric **UNMEASURED** — `sentinel_fmv_confidence_rows`/`rpc_ops_snapshot` timed out in the daytime IO band (known, inbox 08-28T1810Z); raw `fmv_snapshots` counts are not comparable, so no delta was fabricated. Last-known (08-28): TS 7781, AllDay 1599.
- **Sentry:** dark since 08-18 (billing) — not re-queried; a "0" here is a dark reporter.
- **Artifacts:** 11, none flagged/stale, none broken by a daytime schema change. No repair.

## Post-ship regression watch (last 24–48h ships) — CLEAN
Windows split at each fix's deploy time (a raw 24h window pools pre-fix failures and reads as a regression):
- `refresh_wmc_fmv_changed` (8bdfa596, R57 skip-lock): post-fix **163/169 ok = 96.4%**, latest 17:33Z ok 21.6s. Healthy.
- `refresh_wmc_fmv_drift_active` (ecb2563c, changed-set materialisation): post-fix **144/167 ok = 86.2%**, latest 17:33Z ok 27.1s. Healthy (known wasteful drift class).
- `promote_unmapped_sales` (90510112, self-overlap advisory lock): latest 17:36Z ok, `extra.note=skipped_concurrent_run` — guard firing as designed. Only pre-fix failures.
- `wallet-username-resolver` (8fd80727, ok-predicate): **deployed READY**, but last run 15:08Z is PRE-deploy (~16:15Z). First post-deploy run not yet observed → **carry to tomorrow**. Residual failures are honest now (legacy 530 + queue-fetch timeout).
- Packs-column (3d566bd2), log_pipeline_run (643eb26a), telemetry (211b5329): deployed READY, no regression surface; duration-inflation fix verified in ledger.

**No shipped change correlates with a regression. No auto-revert warranted.**

## Shipped
Initial pass shipped nothing (off-hours). Then Trevor asked me to act on what I safely could, so I shipped **one verified DB-only fix** (no push needed):

**`sentinel_fmv_confidence_rows` filter-pushdown — restores the `rpc_ops_snapshot()` baseline.**
- **Problem:** it read `fmv_current` (`DISTINCT ON (edition_id)` over all 3 `fmv_snapshots` partitions) and filtered the view's *output* by collection, so the cross-partition sort ran before the filter and spilled — timing out in the daytime IO band. `rpc_ops_snapshot()` calls it per-collection via LATERAL, so the monitor's fast baseline died ~half the day (known, inbox 08-28T1810Z). Not a missing index — the ideal indexes already exist.
- **Fix:** rewrote it (plpgsql, NULL/non-NULL branches) to push the collection filter *inside* the `DISTINCT ON` against `fmv_snapshots` directly. Non-NULL branch plans as per-partition Index-Only Scan + Merge Append, no external sort (EXPLAIN verified). NULL path unchanged.
- **Migrations:** `20260829202655_..._sentinel_fmv_confidence_pushdown` + `20260829202944_..._fix_ambiguity` (first apply had an OUT-column/table-column ambiguity on `confidence`; fixed by aliasing). Applied via MCP.
- **Verified:** (1) `rpc_ops_snapshot()` now returns all 11 keys, no timeout. (2) Per-collection output matches an independent inline measurement exactly (TS HIGH 2247/MED 5362, AllDay HIGH 170/MED 1335, Golazos MED 2, UFC 0, Pinnacle {}). (3) Security unchanged: `check_secdef_anon_execute_violations()`=`[]`, anon & authenticated cannot EXECUTE, SECURITY DEFINER + STABLE preserved. (4) Not pinned -> no db-invariants drift. (5) Equivalence: edition->collection 1:1; summed distinct-edition currents 27,025 < 27,321 total editions (no double-count).
- **Revert (one statement):** CREATE OR REPLACE back to the prior SQL body reading `FROM public.fmv_current` (LANGUAGE sql STABLE SECURITY DEFINER, search_path public,pg_temp).
- **Target metric:** `rpc_ops_snapshot()` completes < statement_timeout during the daytime IO band.

**-> ACTION FOR TREVOR / Claude Code:** two migration files are staged (uncommitted) at `supabase/migrations/20260829202655_*.sql` and `20260829202944_*.sql` — both idempotent, both containing the final function. Commit them to clear the daily migration-parity reminder (normal apply-then-commit flow; parity is a daily reminder, not a push gate).

**Bonus — FMV accuracy KPI measured** (the metric the timeout was hiding): HIGH+MEDIUM per collection — TS **7,609** (08-28: 7,781, -172), AllDay **1,505** (08-28: 1,599, -94), Golazos 2, UFC 0. Both declines track the ~24h Top Shot legacy-endpoint outage.

## Queued — needs a decision or an access I lack
1. **Top Shot legacy-endpoint decommission (`public-api.nbatopshot.com`).** ~24h+ dead. Migrate `lib/chains/flow/topshot.ts`, `topshot-graphql.ts`, `topshot-badges.ts` to the Studio endpoint **only if** it exposes equivalents for `getUserProfile` / `getMintedMoment` / marketplace-edition search — schemas differ, so this is deliberate work, not a rename. Operator / Claude Code (needs push). *Why not auto: route-logic on FMV/ingest clients (off-limits), needs upstream-schema verification, and no push this run.*
2. **`/insights/deals` stale-ask freshness stamp.** Diagnosis committed (a589c65e); the fix is blocked because `cross-collection-deals-mv` unions three `ask_updated_at` branches that don't mean the same thing (All Day's is `floor_ask_listed_at`, no verification column to swap in). *Why not auto: needs a data-model decision, not a code tweak.*
3. **`snapshot-institutional-wallets` OFFSET→keyset paging.** `(collection_id, moment_id)` is already the ORDER BY, so keyset is a drop-in and strictly safer; page 178 = `LIMIT 250 OFFSET 44500` is quadratic. *Why not auto: edge function — deploy-only, R21 territory.*
4. **Mount-only monitor filings** (0308Z thin-fmv-guard 0830Z-band statement timeout; 0420Z underpriced-board null read; 0425Z jobid-211 dead-slot decay — do NOT delete the slots, they are the thermometer). Diagnoses only; carry forward.
5. **Standing operator blockers (unchanged):** cloud-Cowork git-push credentials; Sentry ingestion dark since 08-18; atlas-proxy wrangler deploy; sports-proxy ESPN 403 (measured dead); #22 stale public branch `claude/todo-implementation-e4tib3` (triage `ee94c8a2a` → GitHub-UI delete → GC → rotate).

## Failed / blocked / reverted
None. No verification failures; production shipping was never engaged.
