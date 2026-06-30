RPC Claude Code handoff — tune the historical buyer-backfill lane (window + batch) (2026-06-20)

Tiny, low-risk: two constant changes in app/api/admin/backfill-topshot-buyers/route.ts. The historical spork lane (?mode=historical, pipeline topshot-buyer-backfill-historical) is LIVE and verified working (first run: buyers_resolved 40, sellers_filled 40, decode_failed 0, 12s). This just makes it efficient + fast. No new logic, no schema, no auth change.

CONTEXT / MEASURED FACTS

The lane decodes pre-current-spork TS sale txs by walking the spork-proxy worker (mainnet19→26). Live smoke test (Cowork, via the worker `?tx=`) established the real recoverable window — which is NARROWER than the constants assume:
- A Nov-2022 tx → tx_not_found_in_listed_sporks (pre-mainnet19; mainnet19's floor ~height 35M is ~early 2023).
- A Jul-2023 tx → found on mainnet23. A Jul-2024 tx → mainnet24. A Nov-2024 tx → mainnet26.
So 2023–2024 are recoverable; 2022 is NOT (same bucket as 2020–21). Null-buyer rows by year: 2024 = 7,857, 2023 = 19,604 (both recoverable, ~27.5K total) vs 2022 = 17,123 (pre-mainnet19, every one will fail with an 8-spork not-found walk ≈ 4s each ≈ ~19 hours of pure wasted spork calls spread across runs).

CHANGE 1 (the important one) — skip the unreachable 2022 window
app/api/admin/backfill-topshot-buyers/route.ts ~L65:
  const HIST_WINDOW_START = "2022-01-01T00:00:00Z"
→ const HIST_WINDOW_START = "2023-01-01T00:00:00Z"
Rationale: 2022 is pre-mainnet19 (proven above), so those ~17K rows can never resolve via the wired sporks — including them just burns one full 8-hop not-found walk per row and delays the recoverable 2023–24 work. (Optionally keep a one-line comment noting 2022 + 2020–21 need mainnet1–18, not wired.)

CHANGE 2 (speed) — raise the batch
app/api/admin/backfill-topshot-buyers/route.ts ~L64:
  const HIST_BATCH = 40
→ const HIST_BATCH = 120
Rationale: the first run resolved 40 rows in 12s against the route's existing wall-clock guard (MAX_RUN_MS, ~600s, well under the 800s Lambda cap). There's enormous headroom on the fast (recent-spork) rows; a bigger batch packs more per run, and the wall-clock guard already bails early + advances the cursor to minSoldAt if per-row latency climbs on older rows — so a larger batch can't blow the cap (same safety the forward lane relies on). 120 is conservative; 200 is also fine if you want.

NET EFFECT: with the 2022 waste gone + batch 120, the ~27.5K recoverable 2023–24 tail drains in ~1–2 days at the current 30-min cron (cron-job.org "RPC Backfill TopShot Buyers Historical", 12,42 * * * *) instead of ~2–3 weeks — no cron-cadence change needed. Once runs resolve 0 (window fully walked), the operator disables the cron (it's one-time/bounded).

REVERT: set the two constants back (HIST_BATCH 40, HIST_WINDOW_START "2022-01-01T00:00:00Z").

VERIFY AFTER DEPLOY: pipeline_runs topshot-buyer-backfill-historical keeps ok=true with buyers_resolved climbing and decode_failed staying ~0 (no more 2022 not-found grinding); the 2023–24 null-buyer count falls toward 0 over a day or two:
SELECT extract(year from sold_at)::int yr, count(*) FILTER (WHERE buyer_address IS NULL) null_buyer FROM sales WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND sold_at >= '2023-01-01' AND sold_at < '2025-01-01' GROUP BY 1 ORDER BY 1;

GUARDRAILS: direct-to-main, no branches/PRs; commit via PowerShell git, re-verify git rev-list --count origin/main..HEAD = 0; tsc clean on the changed file.

Also (doc hygiene, optional): CLAUDE.md / the strategy doc still say "2022–24 recoverable" — correct to "2023–24 recoverable; 2022 + 2020–21 pre-mainnet19" per the smoke test above.
