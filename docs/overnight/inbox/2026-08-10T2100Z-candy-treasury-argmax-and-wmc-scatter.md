# Candy treasury heuristic + wmc scatter — 2026-08-10 ~21:00 PDT (Claude Code, interactive, read-only)

Filed while profiling `candy_pack_market` (that board's own fix SHIPPED — see ledger 2026-08-10,
migrations `20260811033305` / `20260811033331`). **Nothing below was shipped.** No breach is
open: all three affected boards are currently UNDER their liveness caps.

---

## Candidate 1 — [MEDIUM, correctness] `candy_treasury_wallet` is an ARGMAX HEURISTIC, not an identity

- **Definition (live):** `SELECT wallet_address FROM wallet_moments_cache WHERE collection_id = <candy> GROUP BY wallet_address ORDER BY count(*) DESC LIMIT 1` — i.e. "whoever currently holds the most Candy moments is the treasury."
- **Consumers (3, all watchlisted PUBLIC boards):** `candy_pack_market` (treasury_held / collector_held / collector_wallets), `candy_scarcity_board`, `candy_special_serials_board`. `candy_holder_board` excludes the treasury too (394 collector rows vs 395 distinct wallets).
- **Why this is not safe:** the top holder has only **11.2%** of supply (2,840 of 25,375) and #2 has **5.2%** (1,323) — a 2.1x margin, not a treasury-shaped distribution. If any whale accumulates past 2,840, three public boards silently relabel a real collector as "treasury", excluding them from collector counts and moving `treasury_held` / `collector_held`. No alert would fire; the boards would stay green and simply be wrong.
- **⚠ The current answer may ALREADY be wrong.** Coverage profile favours the RUNNER-UP as the treasury:

  | wallet | moments | distinct editions | per edition |
  |---|---|---|---|
  | `BhA2Bfd8t2F2jDiUNdioGRJQt7MiaWo3Ro5H2Yt7APe2` (currently labelled treasury) | 2,840 | **117 of 125** | 24.3 |
  | `1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix` | 1,323 | **125 of 125** | 10.6 |

  A treasury normally retains some of EVERYTHING; the wallet we label treasury is missing 8 editions, the runner-up is missing none. Both span serials 1-250. **This is not resolvable from `wallet_moments_cache` alone** — it needs the real Candy Digital treasury address (on-chain / operator knowledge). Do NOT guess from the data.
- **Suggested action (operator input required first):** obtain the true treasury address, then pin it in a tiny config table (or a `candy_treasury_wallet` view returning that literal) instead of deriving it by argmax. That single change closes this hazard AND removes the ~1.5s scan below from three boards. **Do NOT simply CACHE the current argmax result** — that freezes a possibly-wrong answer and makes it harder to notice.

## Candidate 2 — [LOW / declined, recorded so it is not re-derived] wmc heap fetches are FRAGMENTATION, not vacuum lag

Profiling the treasury scan: index-only scan on `idx_wmc_candy_holder_cover` reads 25,375 rows with
**~11,500 heap fetches** and ~21,000 buffers, ~1,530 ms — ~94% of `candy_pack_market`'s remaining cost.

**Three hypotheses tested and REJECTED — do not re-attempt:**

1. **Vacuum lag / visibility map — REJECTED.** VM is **99.5% all-visible** (105,816 of 106,323 pages) and autovacuum runs constantly (1,927 runs, 4.16% dead, `autovacuum_vacuum_scale_factor=0.05` already tuned). Discriminating test: re-measured immediately after an autovacuum completed — heap fetches moved only **12,070 -> 11,498 (-4.7%)**. A VACUUM will not fix this.
2. **Index tuning — REJECTED.** `idx_wmc_candy_holder_cover` is ALREADY a minimal partial index: `(wallet_address, edition_key) WHERE collection_id = <candy>`, **2,712 kB**, no INCLUDE columns. Index side is only ~330 pages; the cost is heap fetches, which index width does not affect.
3. **Restore HOT by dropping INCLUDE columns — N/A + non-trade.** There are no INCLUDE columns to drop, and per the standing note INCLUDE/predicate columns block HOT exactly like key columns.

**Actual mechanism:** wmc has taken **205M updates at only 1.7% HOT**, so nearly every update writes a
new tuple version and clears a page's visibility bit. Candy's 25,375 rows are scattered at **2.1 rows
per page across 12,043 distinct pages** (of the table's 106,323), so they are maximally exposed to ANY
wmc write anywhere clearing "their" page's bit. Remaining levers are `CLUSTER` (ACCESS EXCLUSIVE on an
831 MB hot table, rewrites it, and decays back) or partitioning wmc by collection (huge migration on
the platform's hottest table). **Both declined — not worth it for boards that are already under cap.**
The economical lever is Candidate 1: stop doing the scan at all.
