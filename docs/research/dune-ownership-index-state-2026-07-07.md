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

---

## Live console inspection (2026-07-07) — the actual query + corrected cost model

Inspected the real Dune query in-console: **query id 7899011, "RPC TopShot ownership — rookie sets"** (@rip_packs_city workspace, Free plan, the workspace's only query). Verified facts:

- **Account headroom:** 492 / 2,500 credits used this cycle (24 Jun–24 Jul), extra credits $0. The daily refresh runs ~39–46 credits/day → ~1,180/month projected → **~1,300 credits/month of free headroom.** Feasibility of expansion within the free tier is confirmed with room to spare.
- **Mechanism:** current owner = latest `TopShot.Deposit` per nft — `ROW_NUMBER() OVER (PARTITION BY nft_id ORDER BY block_height DESC)` over `flow.cadence_events WHERE topics[1]='A.0b2a3299cc857e29.TopShot.Deposit' AND block_date >= '2020-10-01' AND nft_id IN (<Minted rows for the 10 rookie setIDs>)`. Minted CTE supplies set_id/play_id/serial/subedition. Scoped to **10 rookie setIDs**. Last run 52s / 46 credits. The header comment already anticipates a steady-state **incremental delta shape using a block_height cursor**.
- **CORRECTED cost model (important):** the dominant cost is scanning the all-time `TopShot.Deposit` topic on `flow.cadence_events` — which happens **regardless of how many setIDs you keep**. Widening the set filter therefore adds *little* Dune credit; the `nft_id IN (...)` list just gates which rows survive. So **Dune credits are NOT the binding constraint on expansion.**
- **The real binding constraint is result size + the consumption path.** "All sets / all-time" ≈ ~6M ownership rows. The route (`sync-topshot-ownership-dune`) pages results 1k/page inside a 750s Vercel lambda (~100k rows/run today) and upserts each into Supabase. 6M rows can't be paged+upserted in one run.

### Revised plan (sharper than the credit-throttle framing above)
Shard on the **consumption** side, not for Dune-credit reasons but to keep each route run's result-set pageable + the Supabase write bounded:
1. **Parameterize query 7899011's setID list** into a `{{set_ids}}` parameter (replace the hardcoded 10-rookie-set list). Cheap, additive edit.
2. **Add `query_parameters` passthrough** to the `dune-proxy` worker `/execute` (wrangler deploy — operator).
3. **Route:** each run, pull the next N uncovered sets from `get_ownership_backfill_targets()` (cheapest-first), execute Dune with those setIDs, page the bounded result, upsert, mark covered. 1–2 runs/day at ~46 credits each ⇒ the 244-set / ~51M-moment backlog drains in ~3–4 weeks, entirely within the ~1,300/mo free headroom. Steady-state then uses the already-designed block_height delta cursor.

**Not done in-console (deliberately):** I did NOT edit query 7899011 or touch billing — editing the live query risks the working daily pipeline (which now powers the shipped Top Owners + Set Completers surfaces), and true parameterization needs the coordinated worker + route change. Those are safe, ~1-hour operator steps with the recipe above; nothing bills beyond the existing ~46 cr/run.

---

## Staged code (2026-07-07) + operator activation checklist

RPC-side plumbing is committed and **inert by default** (commit 19004c4). Nothing changes behavior until all three operator steps below are done together; until then the daily full-refresh runs exactly as before.

**Committed (done):**
- `workers/dune-proxy` `/execute` now forwards an optional JSON body to Dune's execute API (only `query_parameters` + `performance`). Body-less = unchanged.
- `app/api/cron/sync-topshot-ownership-dune` gains a gated incremental mode: env `DUNE_OWNERSHIP_INCREMENTAL` (+ `DUNE_OWNERSHIP_BATCH_SETS`, default 10) → pulls the next N uncovered sets from `get_ownership_backfill_targets()` and passes them as the `set_ids` execute parameter. Idempotent `nft_id` upsert advances coverage across runs.
- `get_ownership_backfill_targets(p_limit)` work-queue RPC (newest-season-first, cheapest-slice-first).

**Operator steps to activate (≈1 hour, stays free):**
1. **Parameterize Dune query 7899011.** In the Minted CTE, replace the hardcoded rookie-set list `WHERE set_id IN (219, 229, 230, …)` with a text parameter, e.g.:
   ```sql
   WHERE set_id IN (SELECT CAST(x AS integer) FROM UNNEST(SPLIT('{{set_ids}}', ',')) AS t(x))
   ```
   Add parameter `set_ids` (type Text) with **default = the current 10-set CSV** so a param-less run (the daily job) is unchanged. Save + do one manual run to confirm identical output.
2. **Deploy the worker:** `wrangler deploy --name dune-proxy` (from `workers/dune-proxy`). Smoke: `GET /health` → `{ok:true}`. (Requires Cloudflare creds — operator only; Cowork can't run wrangler.)
3. **Turn it on:** set Vercel env `DUNE_OWNERSHIP_INCREMENTAL=1` (optionally `DUNE_OWNERSHIP_BATCH_SETS`), point a 1–2×/day cron at `/api/cron/sync-topshot-ownership-dune` (or reuse the existing schedule). Optional safety: set Dune's per-execution cost cap + monthly credit ceiling so it can never bill.

**Expected result:** each run ingests ~10 uncovered sets (~46 credits, bounded rows), coverage climbs from 824 editions toward the full ~9,779; `get_edition_top_owners` (Top Owners strip) + `topshot_set_completers` light up on each newly-covered edition automatically. Backlog (244 sets) drains in ~3–4 weeks within the ~1,300 credits/month free headroom. Revert anytime: unset `DUNE_OWNERSHIP_INCREMENTAL` (route returns to full-refresh) — no data rollback needed (additive).

---

## Final parameterized SQL for query 7899011 (2026-07-07)

Only the `mint` CTE's `set_id IN (...)` changes; everything else is verbatim. Add a Text parameter `set_ids`, default `219,220,223,233,238,241,243,246,260,261` (TRIM handles optional spaces). A param-less execute (the daily job) uses the default = unchanged behavior.

Changed lines (in the `mint` CTE WHERE):
```sql
    AND CAST(json_extract_scalar(data, '$.setID') AS integer)
        IN (SELECT CAST(TRIM(x) AS integer) FROM UNNEST(SPLIT('{{set_ids}}', ',')) AS t(x))
```
(replaces `IN (219, 220, 223, 233, 238, 241, 243, 246, 260, 261)`).
