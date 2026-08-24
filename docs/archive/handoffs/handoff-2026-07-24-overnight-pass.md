# Overnight pass — 2026-07-24

**Mode:** OFF-HOURS / MONITOR-MODE. Fired ~07:05 PDT (14:05 UTC) — OUTSIDE the 00:00–06:00 overnight window (late fire on next app launch after being closed). Per the quiet-hours guard: full review + Section 2 health triage + post-ship watch, **QUEUE everything, ship nothing** (docs-only commit). Auto-revert of a regressing recent ship would still be allowed — none was warranted.

**No clock skew.** shell 14:05:12Z ≈ DB `now()` 14:05:33Z ≈ newest sale 14:03:08Z ≈ newest FMV 13:54:22Z — all agree within ~20s (the stale-sandbox trap did NOT fire).

**Gates.** No `FREEZE.md`. Lock was stale (RELEASED 2026-07-21); took it over as `night-20260724-27222`. Push AVAILABLE. Supabase + Vercel + Sentry MCP live; Cowork `list_artifacts` live.

**origin/main:** started at `99f3bd9f` (2026-07-21 01:22 PDT). **The daytime monitor woke up mid-run and pushed one commit** (`75b9ad4d`, its `1411Z` tick, ~07:15 PDT) adding inbox file `2026-07-24T1411Z.md` — the normal monitor→night-pass handoff, not a human doing risky work; it touched none of my files (clean rebase) and independently reports health GREEN. My docs commit rebased cleanly on top. Before that single monitor commit, **nothing had been pushed to `main` in ~3 days** — the whole autonomous system (daytime monitor + night pass) was dormant 07-22→07-24 (app closed); today's launch is what re-woke both tasks. The mounted working tree is **13 commits behind** origin (checked out `26727e97`, 07-20 evening; no divergence, no unpushed mount work).

**Result:** shipped **0**, reverted 0, repaired 0, **closed 1** (SIGNUP-FUNNEL wiring), **drained 1 inbox** (the monitor's `1411Z`, folded below + archived). A quiet, honest, green night.

---

## Section 2 — health triage (baseline `rpc_ops_snapshot()` @ 14:10Z; corroborated by the monitor's 14:11Z tick)

**GREEN across the board.**

- **security 0/0/0/0** — `invariants []`, `anon_write_holes []`, `rls_off_base_tables []`, `secdef_anon_violations []`; plus `check_secdef_anon_exec_drift() []` and `check_pgcron_recent_failures()` empty.
- **trust_health: 15 metrics, 0 breaches.** impossible_parallel 0, fmv_sanity 0, ts_uuid_dupes_24h 0, unmapped_backlog 22 (<100), edition_integrity 5 (<50), offer_edition_gap 0. FMV staleness inside threshold: topshot 0h / allday 0h / golazos 0h / pinnacle 4.1h / ufc 15.7h (all < breach).
- **stalled_pipelines []** (the 07-21 baseline's 2 info dropout entries cleared). **sentinel_ts_uuid_editions_48h 0** (was 24).
- **pipeline_alerts:** 1 info (standing `ufc_sales resolving_editions`, 3/24h). No high/critical.
- **pipeline_fails_24h:** carried Dune pair `sales-seller-recovery-dune` 18 + `sales-ingest-dune` 8 (DUNE-DATAPOINT-CAP-402, cursors parked, fails safe), `sales-counterparty-backfill` 12 (contention */5, ~100% recovery), `compute-topshot-pack-ev` 6, `snapshot-institutional-wallets` 4 (the new MED below), `pinnacle-nft-resolver`/`allday-lock-refresh`/`fmv-recalc` 4 each. Each has last_ok newer than last_fail except the Dune pair (by design) and `snapshot-institutional-wallets` (see below).
- **Sentry (production):** 2 unresolved, both non-new-class — `JAVASCRIPT-NEXTJS-20` (player-detail connection-pool timeout, 3 events/3d = carried ACTIVATION-PATH-RPC-TIMEOUTS) and `JAVASCRIPT-NEXTJS-21` (single transient `POST /api/sales-indexer` HTTP error, 1 event/1d; sales ingest healthy — newest sale 14:03Z; noted not queued).
- **Vercel:** prod `dpl_6cjKWSdfZiHz8Mv84eY78FYjdWr4` (`99f3bd9f`) READY; no ERROR-state deploys.
- **Candy note (from monitor):** `candy_mlb` now shows ~53 sales/24h — the expected Candy price signal arriving (chain-two gated), NOT an anomaly. Do not flag.

### Overnight deltas (07-21T08:04Z baseline → 07-24T14:10Z, ~3.25 days)

| Metric | 07-21 | 07-24 | Note |
|---|---|---|---|
| security | 0/0/0/0 | 0/0/0/0 | flat ✓ |
| trust breaches | 0 | 0 | flat ✓ |
| stalled_pipelines | 2 (info) | 0 | cleared |
| sentinel_ts_uuid_48h | 24 | 0 | improved |
| unmapped_backlog_max | 26 | 22 | −4 |
| db_size_mb | 10,393 | 10,804 | +411 (~+126/day, normal) |
| editions TS | 19,488 | 19,506 | +18 |
| FMV TS HIGH+MED | 3,293 | 3,051 | −242; FMV is FRESH (topshot_fmv_stale 0h, sanity 0) ⇒ documented redistribution/oscillation, not a stall |
| FMV AllDay HIGH+MED | 543 | 511 | −32, same class |
| ufc_fmv_stale_hours | 10.6 | 15.7 | +5.1, < breach 30 (thinnest collection) |
| pinnacle_fmv_stale_hours | 9.5 | 4.1 | improved |
| traction users | 20 | 20 | flat — 0 new signups since 06-10 |
| funnel_events/24h | 37 | 10 | low traffic; tracking firing (newest 04:55Z) |

---

## Post-ship regression watch — ALL PASS, 0 reverts

Watch window covers the 07-20/21 wave (soaked 3+ days). Nothing to auto-revert.

- **07-21 ship `audit_20260721_watchlist_allday_listings_indexer`** — row exists (count=1); `detect_stalled_pipelines() []` executes; covered pipeline healthy on cadence (8 runs/2h, last 14:02Z). PASS.
- **07-20/21 security wave** — anon PII revokes HOLD (`has_table_privilege('anon',…)` false on `pro_users`/`user_profiles`/`pack_table_rows`); `check_secdef_anon_exec_drift() []`; `get_pipeline_alerts()` still executes after its drift-arm rewrite. PASS.

---

## Closed this run

- **SIGNUP-FUNNEL-EVENTS-ZERO-POST-DEPLOY** (monitor 1411Z LOW; first raised 07-21) — **wiring CONFIRMED, closed as a traffic reality not an instrumentation defect.** Read-only grep proves all three events are wired: `signin_click` at `components/HomePageMarketing.tsx:221` (home_header) + `:766` (home_pricing); `account_created` at `app/auth/confirm/page.tsx:103`; `email_capture_submitted` at `components/DealWatchCapture.tsx:48`. And `home_view`/`collection_view` ARE recording (24/102 in 7d), so `trackFunnelEvent` works end-to-end. The three signup events are 0 because there were genuinely 0 sign-in-CTA clicks / 0 new signups / 0 share captures over thin traffic — a demand problem, not a wiring one. (This is exactly the monitor's stated closure criterion.)

## Artifacts

17 listed / 15 active (`rpc-growth-funnel` + `rtr-pack-finder` are known retired tombstones) — identical to the 07-21 baseline, none new, none broken. No schema changed (origin static bar the monitor's inbox commit), so no artifact query/logic can have drifted. Nothing to repair.

## Shipped

**2 total, both Trevor-directed.**

**1 — `idx_topshot_insider_buybacks_buyer_moment`** on `public.topshot_insider_buybacks (buyer_address, moment_id)`, applied live CONCURRENTLY via execute_sql (parity migration committed). Fixes the SNAPSHOT-INSTITUTIONAL failure: `compute_institutional_wallet_diff()` loops per newly-arrived moment (6,535/day for the NBATopShotCommunity wallet) doing an `EXISTS` filtered by `(buyer_address, moment_id, sold_at::date)`; the only buyer index was `(buyer_address, sold_at DESC)` with no moment_id, so each EXISTS scanned all 24,518 of the buyer's rows (~160M examinations) → >150s → the 30s service_role ceiling. New index → direct seek: hot EXISTS 1.4–2.1 ms, whole RPC **388 ms–4.07 s** vs the prior timeout; idempotent. Running it also caught the wallet up (buybacks 24,518 → 31,053, +6,535 = today's arrivals). **Independent subagent PASS 5/5.** **Revert:** `DROP INDEX IF EXISTS public.idx_topshot_insider_buybacks_buyer_moment;` **Re-check:** `snapshot-institutional-wallets` ok=true on its next 10:07Z cron tick.

**2 — Contention pass ("keep going"): 6 partial indexes `idx_sales_<2020..2025>_nullseller_soldat`** on `sales_<year> (sold_at DESC) WHERE seller_address IS NULL`, built CONCURRENTLY **one partition at a time with health checks between** (no parallel wave — 07-14 IOPS lesson). Fixes the **#1 disk-IOPS consumer** `claim_sales_counterparty_batch` (186.8M reads, mean ~39s, routinely timing out): the runtime-cursor claim seq-scanned all 8 `sales` partitions and sorted ~1M rows/call; the partial indexes give an ordered-append + per-partition index scan that stops after the LIMIT. **~39s → 546 ms warm / ~2.7 s cold, ~19x fewer disk reads**, lower partitions "never executed". `sales_2026` (active-ingest) left unindexed on purpose (zero added write-path cost). **Independent subagent PASS.** **Revert:** `DROP INDEX IF EXISTS public.idx_sales_2020_nullseller_soldat, ...2021..., ...2022..., ...2023..., ...2024..., public.idx_sales_2025_nullseller_soldat;` **Re-check:** `sales-counterparty-backfill` claim timeouts trend to 0.

**SECURITY DRIFT FLAGGED (not fixed): CANDY-VIEW-SECURITY-INVARIANT-DRIFT.** `check_public_security_invariants()` went []→2 mid-session (independent of the index ships): `view_unexpected_definer` on `candy_pack_ev_model` + `candy_secondary_board` — two NEW Candy views (Candy price signal started ~today). Assessed SAFE: both `security_invoker=true`, postgres-owned, `has_table_privilege(anon/authenticated)`=false (no leak). It's an allowlist/drift signal for unvetted new views. Not auto-fixed (Candy gated + security-invariant machinery = off-limits); owner should vet + allowlist to clear.

## Queued / carried

**NEW this run — RESOLVED (see Shipped): SNAPSHOT-INSTITUTIONAL-WALLETS-COMMUNITY-DIFF-TIMEOUT.**

- **[FIXED via `idx_topshot_insider_buybacks_buyer_moment`]** Original finding — from the monitor's 1411Z tick. `snapshot-institutional-wallets` has been ok=false for 2 days (8 fails over 07-23+07-24, 0 successes; last clean 07-22). The run snapshots its other wallets fine (63,596 moments, 1,268 buybacks inserted) but the single **NBATopShotCommunity mega-wallet** (`0x4d2c9216f1dca098`) TopShot-holdings diff step (`op_label=diff_95f28a17`) cancels on the statement timeout after 3 retries, marking every run partial/ok=false; that one wallet's TS snapshot is stale since 07-22. **Blast radius LOW** (one analytics/leaderboard wallet; buyback inserts + all other wallets unaffected; not a user-facing surface) but it will NOT self-heal. **Suggested fix (NOT auto-ship — off-hours + monitor said don't; and it needs reading the diff query first):** make `diff_95f28a17` cheaper for very large wallets — a covering index on the diff's join key, or page the diff — NOT a proconfig `statement_timeout` bump (the 3 retries already hit the ceiling, and proconfig does not extend the service_role/PostgREST ceiling — disproven repeatedly). Also worth checking whether other mega-wallets sit near the same edge. Owner/CC or a genuine overnight after reading the snapshot fn.

**Carried (unchanged, all owner/CC/route-logic-gated):** CORRELATED-PIPELINE-DROPOUT-DETECTOR (MED, nc2), PIPELINE-WATCHLIST-COVERAGE-AUDIT (MED, nc2), CLAUDE-MD-GOLAZOS-LOW-ASK-STALE (LOW docs — golazos low_ask 116/218 frozen since 07-21 23:26Z, 0 offers, no refresh pipeline; correct date, don't close), ACTIVATION-PATH-RPC-TIMEOUTS (Sentry NEXTJS-20), DUNE-DATAPOINT-CAP-402 (MED), TOPSHOT-BADGE-CATALOG-429 (LOW/MED, route pacing — NOT a proconfig timeout), WMC-PRUNE-120S-CEILING, LIVE-HEALTH-ARTIFACT-DEAD-TABLE-CREDIT, COMPUTE-LALIGA-PACK-EV-ALGO-VERSION-SCHEMA-MISMATCH, NON-WAVE-WALLET-BACKFILL-DRIVER, WMC-LOCK-FRESHNESS, MARKET-EDITION-LINK, TOPSHOT-WMC-FOSSIL-DRAIN, Panini go-live (Trevor editorial), chain-two/Candy (gated — Candy price signal now arriving).

## Failed / blocked / auto-reverted

None.

## Note for Trevor

The daytime monitor and night pass did not run 07-22 → 07-24 (origin/main static since the 07-21 01:22 PDT pass; app evidently closed). Both tasks re-woke on today's ~07:05 PDT launch — the monitor's 1411Z tick and this pass. Health held green across the gap (production self-runs regardless of the tasks), so nothing was missed operationally; the one real degradation the monitor caught (snapshot-institutional-wallets, above) is scoped to a single analytics wallet and is queued.
