# Handoff 2026-06-17 — alerts-dispatch deal leg was O(subscriptions × 27s board scan)

Plain text. Claude Code's direct file inspection wins over this doc. Monitor flagged this as ALERTS-DISPATCH-DEAL-TIMEOUT (deal-leg 30s timeout 18:44Z + 22:44Z).

## STATUS: Part 1 SHIPPED live from Cowork (2026-06-17). Part 2 SHIPPED by Claude Code (2026-06-17, `audit_20260617_dispatch_due_deal_alerts_materialize_pools_once`). Whole item CLOSED.

## Root cause (EXPLAIN ANALYZE, measured 2026-06-17)

`dispatch_due_deal_alerts` loops every active subscription and, PER SUB, calls:
- `build_deal_alerts_for_subscription(sub.id)` -> scans `cross_collection_deals_board` = **22,570 ms**
- `topshot_serial_deal_alerts_for_subscription(sub.id)` -> scans `topshot_underpriced_serials_board` = **4,490 ms**

So each subscription cost ~27s of board scanning. `dispatch_due_deal_alerts` has no `SET statement_timeout`, so it inherits service_role's 30s — one subscriber sat at the edge (tipped over under load = the observed failures), two+ was a guaranteed timeout. The 18:44Z/22:44Z failures were during Trevor's test sub; there are 0 subscriptions now.

Why the boards were slow: both computed latest-FMV-per-edition with a `DISTINCT ON`/`Unique` over the WHOLE partitioned `fmv_snapshots` set (cross board: Unique over 343,052 rows of fmv_snapshots_2026; serial board: Unique over 602,635, and it didn't even filter by collection). The AF1 anti-pattern this codebase already fixed elsewhere.

## Part 1 — LATERAL the boards' latest-FMV — DONE (Cowork, output-preserving, verified byte-identical)

Two migrations shipped + verified live:

- `audit_20260617_topshot_deals_vs_fmv_lateral_latest_fmv` — `topshot_deals_vs_fmv` (the TS half feeding `cross_collection_deals_board`): the DISTINCT-ON-over-all-fmv_snapshots latest-FMV CTE replaced with a per-edition `JOIN LATERAL (SELECT fs.fmv_usd, fs.confidence FROM fmv_snapshots fs WHERE fs.collection_id='95f28a17-…' AND fs.edition_id=e.id ORDER BY fs.computed_at DESC LIMIT 1)`. **cross_collection_deals_board: 22,570 ms -> 1,446 ms (~16x).** Output verified byte-identical (587 rows, md5 `9b06d677…` before and after). `security_invoker=on` + anon/auth SELECT preserved; `check_public_security_invariants()` clean.
- `audit_20260617_underpriced_serials_board_lateral_latest_fmv` — `topshot_underpriced_serials_board`: same per-edition LATERAL (driven off the small `topshot_active_listings` side). **4,490 ms -> 27 ms (~168x).** Output verified byte-identical (19 rows, md5 `253098ab…` before and after). `security_invoker=on` + anon/auth SELECT preserved.

Net: per-subscriber deal-leg cost dropped from ~27s to ~1.45s. On the existing inherited 30s service_role statement_timeout that is ~20 subscribers of headroom (was ~1). The public `/insights/deals` + `/insights/underpriced-serials` pages are unaffected (identical rows).

Revert (only if needed): re-CREATE the prior view bodies (the DISTINCT-ON CTE form) — both prior viewdefs are in the migration history. Keep `WITH (security_invoker=on)`.

## Part 2 — Materialize the deal set once per run — SHIPPED (CC, 2026-06-17)

Migration `audit_20260617_dispatch_due_deal_alerts_materialize_pools_once`. `dispatch_due_deal_alerts` now copies both boards into temp tables ONCE per run (`tmp_deal_pool` = `cross_collection_deals_board WHERE low_ask>0 AND fmv_usd>0`; `tmp_serial_pool` = `topshot_underpriced_serials_board WHERE estimate_quality='tight' AND ask_usd>0`), then each subscription filters those small in-memory pools (615 + 7 rows today) — O(board + subs) instead of O(subs × board). The board scan is paid once regardless of subscriber count.

- The two per-sub functions (`build_deal_alerts_for_subscription`, `topshot_serial_deal_alerts_for_subscription`) were **left intact** — they still back the `/api/alerts/subscriptions` live preview count. The dispatcher inlines their exact WHERE clauses against the temp pools rather than calling them in a loop.
- Added `SET statement_timeout TO '45s'` to the function (effective for the outer statement — the documented function-local pattern here). 45s sits well under the route's 60s lambda, leaving room for the `dispatch_triggered_fmv_alerts` leg that runs after it in the same invocation. No route change needed (`maxDuration` stays 60).
- Output shape preserved; added `deal_pool_size` / `serial_pool_size` for observability.
- SECDEF + search_path + service_role/postgres-only EXECUTE grants preserved; `check_public_security_invariants()` = 0.

**Verified (2026-06-17):** seeded test subs in a `DO` block, ran the new dispatcher, compared its enqueued `subject_key`s to the union of the per-sub functions' deals, then `RAISE`d to roll everything back (no committed test rows). Exact match across 6 scenarios — default (27/27, diff +0/-0), low_discount (31), ts_only (31), tiers (31), serial_range (28), require_jersey (25), all diff +0/-0. `EXPLAIN ANALYZE` with 0 subs = ~116ms.

Revert: re-CREATE the prior `dispatch_due_deal_alerts` body (the per-sub-loop form; in the migration history) — drop the temp-table materialization and the `SET statement_timeout`.
