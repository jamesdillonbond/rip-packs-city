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
