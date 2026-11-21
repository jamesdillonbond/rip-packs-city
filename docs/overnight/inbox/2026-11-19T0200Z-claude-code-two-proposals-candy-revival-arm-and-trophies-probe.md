# Two measured proposals, not shipped: the Candy revival arm re-dates every ~4 days, and the trophies board probes 6.9k rows it never shows

- **Source:** Claude Code cloud autonomous pass, 2026-11-18 ~5:30–6:10 PM PT (Trevor: "Work autonomously … fix any issues you encounter"). Shipped in the same pass (ledger 11-18 ~5:40 and ~5:50 PM PT): the Candy re-date `20261119012913`, the #253 close, and the Sentinel upstream-530 attribution `a8036159f` (verified live: the 5:40 PM PT sweep reads WARN).

## 1. `candy_revival_sales_since_recorded_silence` needs a re-date every ~4 days (LOW, Trevor's call)

- **Measured:** re-dated 11-10, 11-11, 11-14 and 11-18. Each time the floor-10 count was crossed by a dust trickle. This round it was 11 sales worth $44.18 in total (max $21.84), none of them in a 2026 set. Before 10-12 the market did 86–374 sales a day.
- **Cost of leaving it:** a monitor filing, a re-verify and a migration about twice a week, and a BREACH on the board between them. That breach is the "permanently red arm teaches the operator to skim" shape the arm's own comment warns about.
- **Options (the arm's definition is Trevor's call, ledger 11-11):** (a) count USD instead of sales, e.g. breach on more than $250 since the recorded date; (b) count only sales in a current (2026) set; (c) breach on a rate, e.g. ≥ 10 sales/day on any 2 days. (a) and (b) would each have stayed green through all four trickles. Of the two, only (a) would have fired on the pricier 11-14 batch ($637.62, all legacy DC comics); (b) would not.
- **Not changed:** the arm definition (`v_rpc_trust_health`).

## 2. `/insights/trophies` pays the wallet probe for 8,106 candidates and shows 1,209 (LOW)

- **Measured:** `EXPLAIN (ANALYZE, BUFFERS)` on the page's default read (5 published collections, FMV desc, limit 200): 1.9 s, 52k hits and 3.4k reads, of which the `held` CTE's `wallet_moments_cache` probe is 1.3 s of IO. That probe runs over every candidate before the collection filter. By collection the candidates are Candy 5,209, Panini 1,688, Top Shot 621, All Day 500, UFC 48 and Golazos 40, so 6,897 of the probes are discarded. The board-liveness sweep reads the view at 2.2–4.1 s. Vercel logged one `[insights/trophies] read exceeded 8000ms` in 24 h (ISR 3600 s caches that degraded render for up to an hour, the #249/#33 class).
- **Why the CTEs are MATERIALIZED:** `20261110034117` measured the un-fenced plan running the FMV lateral over all 82k editions (523k buffers, 6.8 s). Do not remove the fence.
- **Candidate:** a SQL function `get_insights_trophies(p_collections text[])` with the collection filter inside `cand`. `lib/insights/trophies-board.ts` (shared by the page and `/api/public/insights/trophies`) would call it through `.rpc()` with the same order and limit. Measure buffers before and after. Expect roughly 1.2k probes instead of 8.1k.
- **Not changed:** anything. The change touches a public board's read path on both the page and the API route.

## Revert
n/a (sense-only filing).

## ✅ RESOLVED (Claude Code cloud, 2026-11-20 ~4:55 PM PT — retired in place (append-only); evidence read this session)

Both closed 11-19 (focus.md steer of 11-19 ~9:35 AM PT): the Candy revival arm sums USD with a $250 floor (`20261119113000`, definition delegated by Trevor); `/insights/trophies` filters inside `get_insights_trophies(p_collections)` (single-collection tabs −57 % buffers).
