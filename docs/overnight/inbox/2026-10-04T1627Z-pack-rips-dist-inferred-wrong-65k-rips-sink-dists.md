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

## Early verification read (~9:45 AM PT, ~3.6 k identities in)

The lane pops newest-first, so the first answers are recent packs. Among the disputed rips verified so far, chain identity sides with **neither table 533 times, the purchase 59, and the rip 0**. **`pack_purchases.pack_dist_id` is wrong on recent packs too.** Examples (rip → purchase → chain):
- 8545 → 8549 "2026 NBA Finals: Chance Hit" → 8561 / 8571 / 8558, all "2025-26 Set Completion Reward: …" (138 / 59 / 51).
- 8597 → 8595 "WNBA Metallic Gold LE Standard" → 8601 "… Trade Ticket Pack" (159).
- 8521 → 8527 "WNBA Rookie Debut Chance Hit" → 8526 "… Trade Ticket pack" (43).

**So the repair is chain-only for BOTH tables.** Copying either table into the other would just move the error, and the purchase-copy idea in the plan above is refuted for recent packs. Check how `pack_purchases.pack_dist_id` gets its value (the `pack_rips_propagate_dist_to_purchases` trigger copies the rip's inferred dist; `name_packs_from_identity` falls back to sales history) before trusting it anywhere, including the "purchased under 8512" framing at the top of this filing.

## ✅ Re-key by chain: live (Claude Code, ~11:05 AM PT)

- **`20261004180000`:** re-keyed the **6,262** rips the chain had verified by 11:00 AM PT, every one backed up in `public.audit_20261004_pack_rips_dist_rekey_backup` (RLS on, access revoked, first old value kept). 0 left disagreeing; `check_public_security_invariants()` = `[]`. Before → after: 8597 opened 12,778 → 8,510; 8601 1,700 → 5,066; 8549 879 → 1,138; 8545 4,964 → 4,366; 8512 1,815 → 1,918; 8552 49,564 → 49,093 (most of 8552 not verified yet).
- **`20261004181500`:** the lane `rekey_pack_rips_to_chain_identity()`, pg_cron **704** `rpc-pack-rips-chain-rekey` at :09 / :39. It applies every chain answer from the last hour (idempotent overlap) and logs `pack-rips-chain-rekey`. Positive control by hand: 290 re-keyed, ok. It also catches NEW rips that get an inferred dist before their identity lands. `pack_purchases` is untouched (its trigger only fills NULLs).
- **Still open:** the identity queue (~59 k at 11 AM) drains overnight; the lane re-keys as it lands. The 96 rips with no purchase and no identity are not queued. The writer fix (inference should not run, or should defer, when an identity is pending) is not done. Purchase-side dists (wrong on recent packs too) are not repaired. Revert of all re-keys: `UPDATE public.pack_rips r SET dist_id = b.old_dist_id FROM public.audit_20261004_pack_rips_dist_rekey_backup b WHERE r.id = b.rip_id;`

## ✅ Purchases decided and repaired (Claude Code, ~11:25 AM PT, under Trevor's "do what you think is best")

- **The bought-as vs chain question is answered by data: a pack does not convert.** Of 4,208 purchases disagreeing with the chain, most are `primary_withdraw` deliveries whose dist came from a drop-window match. Standard / Trade Ticket / Chance Hit / reward packs released together are different NFTs in different dists (2,436 deliveries filed 8595 "Standard" are 8601 "Trade Ticket" on chain). Only 289 copied the old rip guess. **Chain is authoritative for purchases too.**
- **`20261004190000`:** purchases re-keyed by chain (4,322 by apply time, backup `public.audit_20261004_pack_purchases_dist_rekey_backup`, RLS on), 0 left disagreeing, invariants clean. The lane (pg_cron 704) now repairs purchases as well as rips.
- **No full sweep of the 208,224 purchased (all opened) packs without an identity.** Where rip and purchase agree, they are both wrong 289 / 77,513 = 0.37% of the time, so about 780 expected errors would cost about 58 h of identity-lane capacity. The lane corrects any of them whose identity is fetched for other reasons.

## Remaining items decided (Claude Code, ~11:35 AM PT)

- **Writer fix (inference before identity): not changed.** `backfill_pack_rip_metadata` only fills NULLs, and pg_cron 704 overrides a wrong guess within an hour of the pack's identity landing. Today's measurements show that function's cost is environmental, so another edit to it buys nothing measurable. Revisit only if `pack-rips-chain-rekey` keeps finding a steady stream of NEW wrong guesses after the backlog drains (read its `rekeyed` per run on 10-06).
- **96 rips with neither a purchase nor an identity:** left. They are not queueable from these tables and are noise against ~450 k Top Shot rips.
- **Exit for this filing:** the identity queue reaches 0, `pack-rips-chain-rekey` falls to single digits per run, and dist 8552's opened count sits near its own ~21.7 k.

## Follow-up scheduled (Claude Code, ~11:45 AM PT)

- Identity backlog boost live (pg_cron 705, removes itself when the queue empties): queue 57,495 → 55,896 in 13 min, all requests 200.
- **One-time cloud check at 7:45 AM PT 10-05** (routine `trig_01DvHXN2tzfAFJUcLHhDspVm`). It re-verifies the exit conditions above plus the 4:13 AM seed, the 429 arm and the rip-metadata lane, fixes small things, and appends results here. The overnight pass does not need to repeat it.

## Read-back (Claude Code, ~6:00 PM PT): exit conditions met

- `pack_nft_identity_queue` = **0**. The last identity was checked at 5:48 PM PT. Boost job 705 unscheduled itself on its 5:37 PM PT tick, logged as `job canceled` because it removed itself mid-run. 0 `zz-*` jobs.
- Lane 704 `pack-rips-chain-rekey`: every run was ok. Rips re-keyed 4,780 · 4,738 · 4,675 · 3,957 and purchases 336 · 614 · 3,650 · 3,954 (4:09 PM to 5:39 PM PT).
- Rows that disagree with a known chain dist: **rips 0, purchases 0**.
- Dist 8552 now has **21,844** rips, down from 49,564 this morning (forecast ~21.7k).
- The 10-05 7:45 AM PT routine only needs to confirm that this holds and that the 4:13 AM PT seed ran clean.
