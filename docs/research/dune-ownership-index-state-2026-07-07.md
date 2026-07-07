# Dune ownership index — state + coverage-expansion note (2026-07-07)

## Answer to "should we leverage Dune here?" — yes, and it already is.

The per-edition **Top Owners** (v2 "Most Owned") and **Set Completers** surfaces need a holder graph that RPC's tracked-wallet cache (`wallet_moments_cache`, ~241 wallets) can't provide. A from-scratch on-chain wallet-walk is infeasible from Vercel/Supabase egress (TopShot has ~6M+ moments). **Dune is the right tool and is already wired up:**

- Route: `app/api/cron/sync-topshot-ownership-dune/route.ts` — triggers a fresh Dune execution, polls to completion, pages results through the `dune-proxy` worker, upserts `public.topshot_ownership` (idempotent on `nft_id`). Handles 429 backoff + a 750s walk budget.
- Env (already provisioned): `DUNE_PROXY_URL`, `DUNE_PROXY_SECRET`, `DUNE_OWNERSHIP_QUERY_ID`.
- **Live state (2026-07-07):** `topshot_ownership` = **102,417 rows / 4,468 owners / 824 editions**, source `dune`, last synced 2026-07-06. The June-27 "inert (0 rows)" note is STALE — the pipeline was lit up since.

## Current scope: the 2025-26 season (Series 8), and it's COMPLETE within that scope

All 824 covered editions are Series 8. For a covered edition the index holds the **full mint** (e.g. `219:7400` = 1,000/1,000 moments across 558 collectors) — not a sample. That is exactly why the Top Owners strip is safe to render there: within scope the holder graph is complete.

## Consumers built on it
- **Set Completers** — `/insights/set-completers` (pre-existing, `topshot_set_completers_mv` off `topshot_ownership`).
- **Top Owners** — edition-page strip via `get_edition_top_owners()` (shipped 2026-07-07). Renders ONLY for covered editions, so it never shows a partial/wrong leaderboard.

## Coverage expansion beyond current season — a COST decision, deliberately deferred

Widening past Series 8 means editing the Dune SQL behind `DUNE_OWNERSHIP_QUERY_ID` (Dune console — operator-only; I have no Dune access). Two blockers make all-time expansion a post-revenue call under the cost-flat rule:

1. **Dune credits/result-size.** All-time TS ownership is millions of rows — beyond the free tier's per-query result cap + monthly credits. The current weekly-ish cadence + Series-8 scope is what keeps it inside free tier.
2. **Walk budget.** The route restarts at `offset=0` each run and caps at ~750s (~103 pages @ 1k/page today). A much larger result set won't finish in one run; it would need **sharding by series into multiple query IDs** (e.g. `DUNE_OWNERSHIP_QUERY_ID_S7`, `_S6`) each on its own cron day, or a paid Dune plan with bigger pages.

**Recommendation:** keep current-season scope for now (it's the high-value active-collecting set and it's free). When revenue clears the cost-flat bar, expand by adding per-season sharded Dune queries + cron days — no route rewrite needed beyond reading N query IDs. Until then, Top Owners + Set Completers are correctly scoped to Series 8 and labelled as the indexed current-season graph.

## If/when expanding (operator runbook)
1. In Dune, clone the ownership query; change the season/edition filter to the target series; confirm result columns stay `nft_id, set_id, play_id, sub_edition_id, owner_address, serial_number`.
2. Add its query id as a new env (e.g. `DUNE_OWNERSHIP_QUERY_ID_S7`) and a sibling cron day (stagger off the S8 run).
3. Minimal route change: loop the configured query IDs. `topshot_ownership` is idempotent on `nft_id`, so scopes merge cleanly; `get_edition_top_owners` + set-completers pick up new editions automatically.

---

## Incremental rollout within the FREE tier (2026-07-07 — answers "can we roll this out slower to stay free?")

**Yes.** Dune free tier = **2,500 credits/month**, usage-based (credits ∝ compute / data scanned per execution), Small+Medium engines, 30-min timeout. You can also set a **per-execution cost cap** and a **monthly credit ceiling** in Dune settings, which HARD-guarantee $0 (an execution that would exceed the cap fails instead of billing). Source: docs.dune.com/learning/how-tos/credit-system.

Scale of the remaining back-catalog (measured): **8,955 uncovered base editions across 244 sets ≈ 51M moments.** Deriving current holders over 51M moments' event history in one execution is far past 2,500 credits/month — hence it must be sliced. Two independent throttles:

1. **Scope throttle (credits per execution).** Parameterize the Dune query (`{{set_id}}` or an edition-list param) and index ONE small slice per execution. Cheapest slices scan the least data → fewest credits. New RPC `get_ownership_backfill_targets(p_limit)` is the work-queue: it returns uncovered sets newest-season-first, cheapest-slice-first, with a moment estimate (e.g. WNBA Rookie Ultimate 1 moment, Skyline 3, Kingmaker 25 → near-zero-credit runs). Set Dune's per-execution cost cap so any accidentally-huge slice fails rather than burns budget.
2. **Cadence throttle (executions per month).** A cursor-driven cron advances N cheap slices per run, spaced so (executions/month × credits/execution) < 2,500. Because `topshot_ownership` is idempotent on `nft_id` + additive, coverage accumulates over weeks. Once complete, the same cron flips to a refresh rotation (hot/current-season sets weekly, cold sets monthly) — still bounded by the budget.

**The one thing to TEST first (in the Dune console, operator):** run the ownership query scoped to a SINGLE small set and read the credits-consumed figure. If a single-set run is cheap (filter pushes down to scan only that set's events), the incremental plan is clean and stays free indefinitely. If the derivation scans the FULL event history regardless of the set filter (no pruning), then scope-narrowing doesn't save credits and only cadence helps (capping total achievable coverage) — in which case rewrite the query to derive holders from a pre-filtered event window, or accept current-season-only until a paid plan.

**Build split.**
- *Operator/Dune (I can't do):* parameterize the query; set the per-execution + monthly cost caps; add the param'd query id as env; measure single-set credit cost.
- *RPC side (shipped 2026-07-07, dormant until provisioned):* `get_ownership_backfill_targets()` work-queue. Still needed when green-lit: a small cursor table + a route loop that (a) pulls the next N targets, (b) calls the parameterized Dune execute per slice, (c) upserts, (d) marks covered — plus a `dune-proxy` worker `/execute` change to forward `query_parameters` (worker deploys via wrangler = operator, per the worker-deploy-drift note). None of that bills anything until the caps are set, so it's safe to stage.

**Recommendation:** stay current-season on the daily full-refresh for now (free, high-value). When you want to widen, do the single-set credit test first; if cheap, wire the cursor cron to walk `get_ownership_backfill_targets()` a few cheap slices per day with Dune's cost caps on — that rolls out the whole back-catalog over ~1-2 months without ever leaving the free tier.
