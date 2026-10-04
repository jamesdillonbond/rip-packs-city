# FOUND — 65,477 Top Shot pack rips carry an inferred `dist_id` that the purchase record contradicts; a few dists act as sinks (8552 reward pack: 27.5k of 49.5k rips are other packs')

**Filed:** 2026-10-04 ~9:30 AM PT, Claude Code (Trevor's box), from a live `pack_lifecycle` 5 s overrun on `/nba-top-shot/pack/dist/8512` that the 10-04 covering indexes did not fix.
**Status:** MEASURED, VERIFICATION QUEUED, NOT RE-KEYED. No rip or purchase row was changed.

## What is wrong

`pack_rips.dist_id` is mostly filled by `backfill_pack_rip_metadata`, which **infers** a rip's distribution by matching its pulled editions against each dist's pool (`pdp.dist_id, count(*) AS matched`). Every writer of the column (`backfill_pack_rip_metadata`, `upsert_pack_rips_from_api`, `collect_pack_nft_identity`, `name_packs_from_identity`) only fills a NULL. So a wrong inference is permanent: the chain-identity lane never revisits a rip that already has a dist. A dist whose pool overlaps many packs absorbs their rips.

**Measured 2026-10-04 (Top Shot only), rip dist vs `pack_purchases.pack_dist_id`:**

| rip dist | title | rips | disagree with purchase |
|---|---|---:|---:|
| 8552 | 2025-26 Set Completion Reward: Video Game Numbers | 49,467 | 27,543 |
| 7724 | — | 20,181 | 18,083 |
| 8545 | — | 4,823 | 4,405 |
| 8597 | — | 11,317 | 4,220 |
| 8526 | — | 11,731 | 2,247 |
| 8521 / 8554 / 8447 / 4184 / … | | | 1,989 / 1,675 / 673 / 380 / … |

Total disputed: **65,477**. The purchase side receives them: e.g. `/pack/dist/8512` ("2026 NBA Playoffs: Chance Hit") has 12,771 purchases but only 1,815 rips under its own dist; 10,244 of its packs are ripped as 8552.

**Who is right?** Chain identity (`pack_nft_identity`, Dapper `searchPackNft`) is the arbiter.
- `pack_purchases.pack_dist_id` agrees with chain on **128,284 / 128,692** (99.7 %).
- `pack_rips.dist_id` agrees with chain on 129,823 / 130,722 overall. But for the rows where rip and purchase DISAGREE, chain sides with the **purchase 428 times, the rip 2 times, and neither 117 times**.
- The "neither" group is **Chance Hit** packs: the purchase names the pack bought (e.g. 7800 "Fast Break … 4 Wins Pack"), while chain names a Chance Hit dist (8433, 7799, 7824, 8601, 8549). That looks like a pack-into-Chance-Hit conversion. So "copy the purchase dist" is wrong for that slice, and **no bulk re-key from purchases was done.**

## What it breaks (user-facing)

Every pack page that reads `pack_rips.dist_id`: opened counts, observed depletion, realized EV and pull value. Examples:
- 8552 shows 49,563 opened; its own records support ~21.7 k.
- 8512 shows ~2 k opened of ~12.8 k purchased.
- 7724 shows 20 k, of which ~18 k are other packs.

It is also why the 8512 lifecycle read is slow cold: 10,753 of its purchased packs fall through to the per-pack "sealed?" probe (42.5 k buffers).

## Done here (additive, reversible)

- **64,930 disputed packs with no chain identity were queued** in `pack_nft_identity_queue` at 9:27 AM PT (`last_seen_at` = the rip's `sealed_at`, so fresh packs still pop first). The identity lane (pg_cron 509, every 5 min, ≤ 300 packs/tick) will fetch their chain dist over roughly a day. **That only writes `pack_nft_identity`**: the collector names rips only where `dist_id IS NULL`, so nothing is re-keyed by it.
- Revert, if ever wanted: `DELETE FROM pack_nft_identity_queue WHERE enqueued_at BETWEEN '2026-10-04 16:26Z' AND '2026-10-04 16:28Z';`

## Proposed repair (next session, once verification has landed)

1. **Re-key by CHAIN only.** `UPDATE pack_rips SET dist_id = i.dist_id` where `pack_nft_identity` disagrees with the rip and the rip has no `dapper_index` attribution. Snapshot `(id, old dist_id)` to a backup table first.
   ⚠ The trigger `pack_rips_propagate_dist_to_purchases` fires on write; check whether it overwrites a purchase's (bought-as) dist with the chain (Chance Hit) dist before running, and decide which meaning each table should hold.
2. **Fix the writer.** A chain identity should override an INFERRED dist, not only fill a NULL (`collect_pack_nft_identity` / `name_packs_from_identity`). Otherwise this re-accumulates. Consider having the inference prefer the purchase's dist when one exists.
3. **Decide Chance Hit semantics** (bought-as vs converted-to) for pack pages. That is a product question if the two differ.
4. Re-read: rip-vs-chain disagreement → ~0; 8552 opened ≈ its purchases; the 8512 lifecycle read no longer probes 10 k packs.

## Addendum (~9:33 AM PT, same session)

- **Partly known before.** The 2026-09-24 comment in `backfill_pack_rip_metadata` records that the pool vote "picked an OLD dist whose pool happens to contain every pulled edition when the pack's real (new) dist had no pool yet" (6,274 rips disagreed with `pack_nft_identity` then). That change made the vote FILL-ONLY, so it stopped overwriting. It did **not** repair rows already wrong, and the vote **still fills NULL-dist rips**, so a rip that reaches this function before its chain identity can still get a wrong dist. This filing's 65k is the accumulated stock.
- **Same function, separate issue:** its `unpriced_retry` leg costs 7.9 s / 800 k buffers to find 85 rows. Stamped-NULL rips with no `moment_acquisitions` are never selected, so they stay at the head of `idx_pack_rips_unvalued_stamped` and the walk grows (the "ORDER BY decides whether a leg progresses" class). The `zero_repair` leg's 14.6 s was fixed separately (`20261004163500`, an empty partial index). The run duration had been rising 28.7 → 40.7 s against a 50 s cap.
