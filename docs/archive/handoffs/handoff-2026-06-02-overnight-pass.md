# RPC nightly autonomous pass — 2026-06-02 (overnight)

**Mode:** OFF-HOURS MONITOR + NO-PUSH. Fired 06:29 PDT (≈29 min past the 00:00–06:00 window) → MONITOR-MODE (queue, don't ship; auto-reverts still allowed). `git push --dry-run` → `could not read Username for 'https://github.com'` → NO-PUSH (no GitHub creds in the scheduled sandbox; bot clone `C:\Users\TDill\rip-packs-city-bot` not mounted — Q7 unchanged). All outputs written to disk **uncommitted**; future runs pick them up from the working tree.

**Bottom line:** Platform GREEN. **Shipped nothing** (off-hours + no-push). No regression attributable to any recent ship → **no auto-revert**. Two clean DB candidates verified ready for the next true overnight run (P1, S1). One real `detect_stalled_pipelines()` catch to flag to the operator (snapshot-institutional-wallets — external cron). One correction: the C2 hydrator-timeout was reported resolved on 06-01 but is **not fully fixed** (re-opened, do NOT revert the CTE fix).

- Run id: 36922897. Lock: claimed the stale RELEASED marker from 2026-06-01 (23h old); will re-mark RELEASED at end (unlink not permitted on this mount).
- Baseline: `docs/overnight/metrics-latest.json` @ 2026-06-01T13:54Z (last night pass; shipped nothing / NO-PUSH).
- Freeze: none. Focus file: none.

---

## What was reviewed

- **Inbox drained (4 monitor runs):** `2026-06-01T18-24-09Z`, `2026-06-01T21-14-07Z`, `2026-06-02T03-15-11Z`, `2026-06-02T06-15-31Z`. Candidates folded: **P1** (evm watchlist threshold), **S1** (anon-readable SECDEF view), C1 (listing-cache cadence — observe-only), C2 (hydrator timeout — claimed resolved; see correction N2), plus two watch-only Sentry items (NEXTJS-1F, NEXTJS-15). Archived to `inbox/archive/`.
- **Ledger read in full.** Open queue: Q2, Q5, Q6, Q7, Q8 (all operator/CC/Trevor-owned). **Q10 shipped live 06-01** (Cowork mig `audit_20260601_watchlist_topshot_listing_cache`) — verified live this run (both rows present @360m). Declined list: empty.
- **Artifacts (11):** enumerated; none flagged broken across the four monitor sweeps; backing queries independently confirmed schema-valid (security-drift 0/0/1, pipeline_runs rollups, FMV breakdowns all ran clean). HTML lives outside the mount (`OneDrive\Documents\Claude\Artifacts`) so not sandbox-readable; no schema changed today → no drift possible → **no repair** (per guidance: don't regenerate working artifacts).
- **Post-ship regression watch (last ~24–48h ships)** — see below.

## Post-ship regression watch — all clean, no auto-revert

| Ship | When | Target / intent | Re-measured now |
|---|---|---|---|
| `340c7d59` (UI: scrub Flowty "By Collectors" tagline; responsive footer; insights KPI 0-flash) | ~06:24Z 06-02 (NEW since last sweep, bot-clone identity) | UI polish only | Deploy `dpl_GtxW2hNUFifGn2HHsMuVvTDLqXgD` **READY**; **no new Sentry since it landed**; UI-only, low blast radius. CLEAN. |
| `dadcc57` (H1–H6 entity ask/offer cells + `cross_market_ask`) | 06-01 23:18Z | collection-aware ask/offer | Deploy `dpl_2ktaTGCm55TVGYrbXnEHaXjSaN3g` READY; migration `audit_20260601_get_edition_detail_standard_cross_market_ask` live; no attributable Sentry/pipeline fault. CLEAN. |
| `audit_20260601_v_moments_needing_hydration_materialized_cte` (C2 view fix) | 06-01 PM | moments-hydrator timeouts → 0 | **PARTIAL — see N2.** Helped in isolation but the candidate read still times out at the 06:00Z/12:00Z cron rushes (2 fails since the fix). NOT a regression of the fix; do NOT revert. |
| `audit_20260601_funnel_events_anon_insert_size_caps` | 06-01 PM | bound anon INSERT | additive policy; no regression signal. CLEAN. |
| `2f26044` (insights offer-spread + deals pages) | 06-01 AM | new public surfaces | READY; backing views healthy. CLEAN. |
| `7c1b81b` / `eda078c` / `8605c43` (sitemap prune / onboarding / evm getLogs 5k — Q6) | 06-01 AM | SEO / honesty / evm 429 softening | all READY; evm still 2 fails/24h (Base-429, no-consumer plane — expected, softened not eliminated). CLEAN. |

Vercel: **20/20 recent prod deploys READY, 0 ERROR.**

---

## Section 2 — health-drift findings + deltas

**`detect_stalled_pipelines()` returns 1 — `snapshot-institutional-wallets` (real, operator-owned). See N1.** (`evm-transfers-ingest` is NOT tripping now — it ran within 60m; the 06:15Z monitor caught it at a tick boundary, confirming P1.)

Pipeline failures last 24h — all transient, self-recovering, none deploy-attributable, none a logic fault:

- `pinnacle-nft-resolver` 6/288 (upstream timeout), `wmc-fmv-populate` 4/345 (lock timeout), `topshot-moments-hydrator` 3/138 (candidate-read statement timeout — N2), `golazos-listings-indexer` 2/92, `pack-events-ingest` 2/90, `pack-pull-source-rip-id-backfill` 2/47, `compute-topshot-pack-ev` 2/89 (`time_budget_exceeded`), `evm-transfers-ingest` 2/23 (Q6 Base-429), `topshot-fmv-populate` 2/2 (pool/statement timeout), + 4 pipelines 1 fail each. All clustered at the 00:00Z / 06:00Z / 12:00Z cron rushes (connection-pool / statement / lock / upstream timeouts).
- `topshot-fmv-populate` failed both its 2 logged runs, but **FMV is fresh** — the canonical writer `fmv-recalc` wrote both collections at 13:28Z (~12 min). The populate path is the known-intermittent connection-pool offender; not a freshness regression.

Security (catalog SQL, one statement per call):

- RLS-off public base tables: **0**.
- anon/authenticated write grants on RLS-off base tables (`relkind r,p`): **0**. *(Note: the un-filtered version of this query returns 48 views — the inert default PostgREST write grants on non-updatable views; the `relkind IN ('r','p')` filter is mandatory per CLAUDE.md §7 / the weekly-health-check fix. Base-table answer is 0.)*
- anon-readable non-`security_invoker` views: **1** — `v_moments_needing_hydration` (anon + authenticated SELECT). This is **S1** (see queue). Posture is 1, regressed from the Q1-era 0; standalone-shippable.

Sentry: **2 unresolved, both 1-event, neither spiking, neither new since the last deploy.** `NEXTJS-1F` (/dashboard "TypeError: Load failed", ~10h old, 1 event — WebKit failed-fetch phrasing = transient client abort; predates `340c7d59`; watch). `NEXTJS-15` (gated AllDay `listing_resolution_failures_inserted`, 1 event/22h — the 221ab64 gating is working; ready to mark resolved if it clears 24h).

Overnight deltas vs `metrics-latest.json` (06-01 13:54Z baseline) — everything healthy/improving:

| Metric | Baseline | Now | Note |
|---|---|---|---|
| FMV TS HIGH+MED | 880 | **933** | improving (NO_DATA 5109 → 4634) |
| FMV AllDay HIGH+MED | 267 | **274** | flat-up (NO_DATA flat 522) |
| FMV freshness | ~10m | ~12m | fmv-recalc healthy |
| Sentinel TS-UUID-48h | 40 | 45 | <250 ok (normal inert accrual) |
| unmapped_sales open | 147 | 147 | flat |
| editions TS / AllDay / Golazos / UFC | 16308 / 6191 / 581 / 446 | 16334 / 6191 / 581 / 446 | +26 TS, rest flat |
| DB size | 5912 MB | 5966 MB | +54 MB / 24h (normal) |
| Security (RLS-off / anon-write / anon-SECDEF-view) | 0 / 0 / — | 0 / 0 / 1 | S1 is the lone view-level exception |

---

## SHIPPED

**None.** OFF-HOURS + NO-PUSH. (DB migrations are technically mount-independent, but MONITOR-MODE queues everything except auto-reverts; no-push independently blocks code/deploys.) No auto-revert was warranted — no recent ship is regressing.

## QUEUED — ready for the next true overnight (in-window) run or operator

### P1 — [LOW–MED] raise `evm-transfers-ingest` watchlist threshold 60m → 150m (kill the hourly `detect_stalled_pipelines()` false-positive)
Monitoring-config only (`UPDATE pipeline_cadence_watchlist`), additive/reversible, not route logic, not off-limits — same class as Q10. Logged cadence is strictly hourly at :00 but the threshold is 60m, so `silent_minutes` crosses 60 at nearly every hour boundary (the 06-02 06:15Z monitor caught it at 66m). An hourly cry-wolf on `detect_stalled_pipelines()` — the deterministic stall check built after the Q3 incident — trains us to ignore its output. **Not auto-shipped: off-hours.** SHIP-eligible next in-window run.
```sql
-- migration
UPDATE pipeline_cadence_watchlist
SET max_silent_minutes = 150,
    notes = 'Beezie Collectibles ERC-721 transfer indexer on Base. Logged cadence is hourly at :00 (the prior */30 8,38 note was stale); 150m grace covers one 429-skipped tick. No product consumer — monitoring only.'
WHERE pipeline = 'evm-transfers-ingest';
-- revert
UPDATE pipeline_cadence_watchlist
SET max_silent_minutes = 60,
    notes = 'Beezie Collectibles ERC-721 transfer indexer on Base. Cron 8,38 every 30min. Catching up from block 41M.'
WHERE pipeline = 'evm-transfers-ingest';
```
Target/verify: `detect_stalled_pipelines()` no longer lists `evm-transfers-ingest` (it runs hourly, always < 150m).

### S1 — [LOW–MED · security] close the anon-readable SECURITY DEFINER view `v_moments_needing_hydration`
Verified live this run: `relkind=v`, no `security_invoker` (executes as definer → bypasses base-table RLS), **both `anon` AND `authenticated` hold SELECT**. It is the lone exception the anon-readable-SECDEF-view check returns (posture 1, regressed from the Q1-era 0). Internal pipeline plumbing — `topshot-moments-hydrator` reads it via `service_role` (unaffected by either fix); no anon HTTP route selects it; data is moment-hydration candidate metadata (no PII/secrets). Additive/reversible, not route logic, not destructive, not off-limits. **Not auto-shipped: off-hours.** SHIP-eligible next in-window run.
```sql
-- preferred (internal view, no anon reader): REVOKE
REVOKE ALL ON public.v_moments_needing_hydration FROM anon, authenticated;
-- revert
GRANT SELECT ON public.v_moments_needing_hydration TO anon, authenticated;
-- OR (Q1 precedent, keeps grant but enforces caller RLS):
ALTER VIEW public.v_moments_needing_hydration SET (security_invoker = on);   -- revert: SET (security_invoker = off);
```
Verify after: anon-readable-SECDEF-view check returns 0; `topshot-moments-hydrator` still runs (service_role path unaffected).
**Bundling note (see N2):** if the operator/CC instead re-optimizes this view for the N2 timeout via `CREATE OR REPLACE VIEW`, set `security_invoker = on` in the SAME statement so S1 + N2 close together.

### N1 — [MED · operator] `snapshot-institutional-wallets` stalled — `detect_stalled_pipelines()` catch (Q3-class external cron)
This run's `detect_stalled_pipelines()` flagged it: silent **1892 min (~31.5h)** vs the 1800m (30h) threshold. History: last **success 2026-05-30 13:16Z**; the last two scheduled runs **both failed** on connection-pool timeout during the 06:00Z cron rush (`2026-05-31 06:00Z` mark_signal_wallets…, `2026-06-01 06:00Z` wmc_load_page_2); and **no run at all fired at 06-02 06:00Z** (the established daily slot — it ran 06:00:4xZ on 05-30/05-31/06-01). Precedent (watchlist note + 2026-05-08): the cron-job.org entry stops firing while the route is healthy on manual invoke — same class as Q3 (TS-sales-indexer). **Not shippable by me** (external cron + transient pool timeouts, not a code/migration fix). Low product impact (institutional-wallet snapshots, 0–3 rows/run, feeds analytics).
- **Operator action:** check/re-fire the `snapshot-institutional-wallets` cron-job.org entry. Manual trigger: `curl -H "Authorization: Bearer $INGEST_SECRET_TOKEN" <fn-url>`. Consider whether its 06:00Z slot should move off the cron-rush peak (the last 2 logged runs died on pool exhaustion there).
- **Watchlist note (Q9 tension):** Q9 had declined watchlisting this pipeline (irregular cadence, normal gaps to 48–53h); it was later added at 1800m anyway. Tonight's hit is *partly* legitimate (2 failed runs + a clearly-missed daily slot) but the 30h threshold can still false-positive during a genuinely-long irregular gap. Leave the threshold as-is for now; revisit only if it cries wolf without an accompanying failure/miss.

### N2 — [MED · operator/CC] RE-OPEN: C2 (`v_moments_needing_hydration` candidate-read timeout) is NOT fully resolved
The 06-02 03:15Z monitor marked C2 resolved (the 06-01 `audit_20260601_v_moments_needing_hydration_materialized_cte` fix; 0 fails as of 03:15Z). **Live data contradicts that:** `topshot-moments-hydrator` has failed twice more *since the fix* — `2026-06-02 06:12:04Z` (30.7s) and `2026-06-02 12:22:04Z` (18.8s) — both the **same** error `candidate_read: v_moments_needing_hydration select: canceling statement due to statement timeout`, both at the 06:00Z/12:00Z cron rushes. 3/138 in 24h, self-recovering, no observed hydration backlog. The materialized-CTE fix IS net-positive (588ms→167ms in isolation) — **do NOT revert it** (reverting restores the pathological Merge Anti Join and makes this worse). The residual is the candidate read still exceeding `statement_timeout` under peak cron-rush contention. **Not auto-shipped** (touches the hydrator/ingest-adjacent read path — invisible-failure class). Suggested deeper fix for operator/CC: bump the candidate-read `statement_timeout` for this specific call, add a supporting index for the anti-join predicate, or further reduce the view's cost; and (per S1) fold `security_invoker = on` into the same `CREATE OR REPLACE VIEW` to close S1 simultaneously.

### Carried forward (unchanged, operator/CC/Trevor-owned)
- **Q2** — `compute-laliga-pack-ev` cadence (by-design Golazos, no confirmed primary pack path; watch; operator verifies cron). Not erroring (absent from fail + stall lists).
- **Q5** — smoke sales-lag threshold rebase to last-successful-run (operator/CC).
- **Q6** — `evm-transfers-ingest` Base-429: ingest-side backoff shipped (`8605c43`); the remaining *watchlist-threshold* piece is now **P1**.
- **Q7** — scheduled-sandbox git fragility: bot clone created + push-verified but NOT mounted in the scheduled sandbox; this run is again NO-PUSH, confirming Q7 persists. Trevor's call (sandbox-native clone route). The stale `.git/index.lock` (noted ~33h old at the 06-15Z sweep) still blocks in-sandbox `git add`.
- **Q8** — `badge-sync` row-grain `onConflict:id` vs `UNIQUE(external_id,collection_id)` (MED, needs Trevor's row-grain decision; **moot for offers** since A1–A6 decoupled offers via `edition_offers`).

### Sentry housekeeping (operator)
- `NEXTJS-15` (gated AllDay) — 1 event/22h, the gating works; mark resolved once 24h-clean. `NEXTJS-1F` (/dashboard Load failed) — watch only (1 event, transient client abort), promote only if it spikes.

## FAILED / AUTO-REVERTED
None. No verification failures (nothing shipped). No regression met the auto-revert bar.

---

*Output written uncommitted (NO-PUSH): this handoff, `docs/overnight/ledger.md` (P1/S1/N1/N2 added; Q-items carried), `docs/overnight/metrics-latest.json` (overwritten with tonight's values), `docs/overnight/inbox/*` archived, CLAUDE.md Recent-sessions entry prepended, `.lock` re-marked RELEASED.*
