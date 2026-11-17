# Editions merge round 2 + NO_DATA catchable-tail audit — 2026-05-28

Companion to `docs/handoff-2026-05-28-cowork-pass.md` (Items 3 + 6) and `docs/handoff-2026-05-28-fmv-items-4-5.md` (the 962f324 code patch already in production).

This session shipped the re-merge of the post-2026-05-26 UUID-dupe regrowth (Item 3) and characterized the NO_DATA catchable-tail population (Item 6). One DB migration applied live.

## TL;DR

- **Item 3 — Merge shipped.** 4,991 TS UUID-keyed dupes deleted. Total TS editions: 15,957 → **10,966**. Integer canonical preserved at 8,997. Still-mergeable: 0. Single atomic migration replaced the May 26 11-chunk wmc sequence because wmc had 0 rows pointing at the dupes (the May 26 chain held).
- **Item 6 — Already in flight.** The catchable cohort grew from 382 (earlier today) to **1,330 NO_DATA editions with sales in last 180 days** after the merge repointed dupe sales onto canonicals. 277 of those have 30+ sales — HIGH-confidence-worthy. The `962f324` Step 5b widened predicate (Items 4+5 code patch) is actively catching them: 3,000 historical_fallback writes in the 30 minutes after the merge, dropping NO_DATA total from 8,558 → 5,356 (-37%).

## Item 3 — Re-merge details

### Pre-flight (verified inline)

| metric | value |
|---|---:|
| Total TS editions | 15,957 |
| Integer canonical | 8,997 |
| UUID-keyed dupes | 6,960 |
| Of those: mergeable (has on-chain ids + canonical exists) | 4,997 |
| Of those: inert orphans (NULL on-chain ids) | 1,878 |
| Of those: legitimate UUID-only (no canonical pair) | 72 |
| Population stability check | 0 new dupes in 2h pre-merge — writer fix holding |

### Dependent-table footprint on mergeable dupes

| Table | Rows | Collisions | Action |
|---|---:|---:|---|
| `sales` (partitioned) | 527 | 0 (no UNIQUE on edition_id) | straight repoint |
| `moments` | 644 | 59 on `(edition_id, serial_number)` | delete-then-repoint |
| `fmv_snapshots` (partitioned) | 6,342 | 0 (PK is `(id, computed_at)`) | straight repoint |
| `price_snapshots` (partitioned) | 34 | 0 | straight repoint |
| `pack_drop_pool` | 19,847 | 0 | straight repoint |
| `badge_editions` | 1,131 | 68 on `(external_id, collection_id)` | delete-then-rewrite-external_id |
| `wallet_moments_cache` | **0** | — | nothing (May 26 chain held) |
| `offers`, `portfolio_moments`, `watchlist_items`, `special_serial_holders`, `special_serial_lookup_failures`, `topshot_insider_buybacks`, `cached_listings_v2`, `user_wishlists`, `user_trade_offers`, `trade_matches`, `marketplace_offers` | **all 0** | — | nothing |

CASCADE-FK dependents (`watchlist_items`, `user_wishlists`, `special_serial_holders`, `special_serial_lookup_failures`) all had zero rows pointing at the dupes — no silent data-loss risk.

### Migration shipped

`audit_20260528_merge_topshot_uuid_dupes_post_writer_fix` — single atomic transaction using a `TEMP TABLE merge_staging ON COMMIT DROP` to snapshot the dupe→canonical map at txn start, then:

1. moments: collision DELETE + UPDATE (59 rows deleted, 585 repointed)
2. sales: UPDATE (527 rows)
3. fmv_snapshots: UPDATE (6,342 rows)
4. price_snapshots: UPDATE (34 rows)
5. pack_drop_pool: UPDATE (19,847 rows)
6. badge_editions: collision DELETE + UPDATE-external_id (68 deleted, 1,063 rewritten; `set_id`/`play_id` columns nulled per the May 26 protocol)
7. DELETE FROM editions WHERE id IN staging.dupe_id (4,991 editions deleted)

Total transaction footprint: ~28,500 rows. No chunking needed (within `apply_migration`'s envelope; well under the ~700k tx-size cap per memory `mcp-execute-sql-tx-size-cap`). Migration succeeded in one execution.

### Post-merge state

| metric | pre-merge | post-merge | delta |
|---|---:|---:|---:|
| Total TS editions | 15,957 | 10,966 | -4,991 |
| Integer canonical | 8,997 | 8,997 | 0 (no canonicals damaged) |
| UUID remaining | 6,960 | 1,969 | -4,991 |
| Still mergeable | 4,997 | 0 | -4,997 |

The 1,969 UUID remnant breaks down as:
- ~1,890 inert orphans (NULL on-chain ids; can't merge without a pair to repoint to)
- 72 legitimate UUID-only editions (no integer canonical exists for them; not dupes)
- ~7 drift from new INSERTs during the merge transaction

**Spot-check headline:** Deni Avdija Fresh Threads 2024-10-24 still resolves to integer canonical `168:5766` with team_name = "Portland Trail Blazers" (the May 26 headline win preserved).

### Trigger behavior post-merge

5 new UUID-keyed stub editions were INSERTed in the 10 minutes after the merge, all with `set_id_onchain=NULL, play_id_onchain=NULL` and `update_lag = 00:00:00` (INSERT-only, no later UPDATE attempt). The trigger's INSERT predicate `set_id_onchain IS NOT NULL AND play_id_onchain IS NOT NULL` evaluates FALSE, so these slip through as inert orphans. They're NOT the GQL-catalog writer (which `dcdc035` fixed to populate on-chain ids inline) — likely a stub-creating wallet-backfill or hydrator path that legitimately doesn't have on-chain ids at write time. They're inactive (no canonical link, NULL on-chain ids → invisible to set/play-keyed reads) and not harmful. **Worth a follow-up code investigation but not a blocker.**

## Item 6 — NO_DATA catchable tail

### Updated population numbers (post-merge)

Earlier today's diagnostic noted 382 catchable TS NO_DATA editions. After the merge repointed dupe sales onto canonicals, the population is actually **1,330** — many of these had their dupe's snapshot history merged in, so the canonical now reads NO_DATA despite having recent sales.

Breakdown by sales-volume cohort:

| 180d sales cohort | editions |
|---|---:|
| 30+ sales | 277 (21%) — HIGH-worthy by volume |
| 10-29 sales | 311 (23%) — MEDIUM-worthy |
| 5-9 sales | 265 (20%) |
| 1-4 sales | 477 (36%) |
| **total** | **1,330** |

Median: 8 sales in 180 days. Average days since last sale: 17.

### Root cause

Every one of the top 10 NO_DATA-with-sales editions has 348-1,126 sales in the last 180 days and reads NO_DATA. Examples:

| edition | external_id | tier | sales_30d | sales_180d | algo |
|---|---|---|---:|---:|---|
| LeBron James, Top Shot This | 224:8241 | FANDOM | 62 | 1,126 | cold-tail-1.0 |
| Max Shulga, Rookie Debut | 219:8387 | COMMON | 155 | 667 | cold-tail-1.0 |
| Cade Cunningham, Bag Work | 244:8396 | COMMON | 268 | 516 | cold-tail-1.0 |
| Stephon Castle, Bag Work | 244:8408 | COMMON | 141 | 482 | cold-tail-1.0 |
| Luka Dončić, Bag Work | 244:8400 | COMMON | 108 | 421 | cold-tail-1.0 |

All on algo `cold-tail-1.0`, snapshots written 2026-05-26 / 2026-05-27. Pattern: `drain-fmv-cold-tail` writes NO_DATA when its 30-day sales lookup returns zero rows (its query filters `AND e.collection_id = v_collection_id`). For dupe-keyed editions pre-merge, the sales were under the UUID `edition_id`, so the canonical's lookup found 0. After merge: canonical now owns all the sales.

### Already in flight via 962f324

The `962f324` code patch (Items 4+5, shipped at this session's start) widened Step 5b's predicate from `WHERE fs.edition_id IS NULL` to `WHERE (la.edition_id IS NULL OR la.algo_version NOT LIKE '1.7.%')`. This catches every cold-tail-1.0 NO_DATA edition with historical sales.

3 fmv-recalc ticks have run since the merge (04:23, 04:23, 04:26 UTC), each writing `historical_fallback: 1000` rows. NO_DATA confidence count dropped from **8,558 → 5,356 in 30 minutes** (-37%) — the catch-up is healthy and aggressive.

### What didn't need separate action

The handoff Item 6 proposed an investigation step (sample 25, trace one through `/api/fmv-recalc` manually). That investigation is now superseded — the Items 4+5 patch is the fix, and it's resolving the cohort in real time. No additional ship needed.

## Confidence-distribution shift

Pre-session vs end-of-session (latest snapshot per edition, all collections):

| confidence | session start | end of session | delta | reading |
|---|---:|---:|---:|---|
| HIGH | 423 | 263 | -160 | dedup; pre-merge double-counted dupes as separate HIGH editions |
| MEDIUM | 894 | 682 | -212 | same |
| LOW | 10,656 | 9,927 | -729 | dedup + Item 5 STALE-ifications |
| ASK_ONLY | 559 | 266 | -293 | dedup |
| SALES_ONLY | 403 | 65 | -338 | dedup |
| STALE | 1,673 | 1,625 | -48 | dedup minor |
| **NO_DATA** | **8,641** | **5,356** | **-3,285** | **Items 4+5 catch-up + dedup** |
| **total** | **23,249** | **18,184** | **-5,065** | merge removed 4,991 dupes |

The HIGH and MEDIUM drops look bad in isolation but reflect dedup honesty — a dupe and its canonical were each being counted, and they often shared the same confidence rating. After the merge, the canonical retains the rating and the dupe is gone. The honest **HIGH+MEDIUM% across all collections** is 945 / 18,184 = **5.2%** vs pre-merge 5.7% — essentially unchanged. The story isn't HIGH count, it's that the FMV signal is now on the correct edition_ids (no more "Philadelphia 76ers" team_name reading FMV for a Portland Trail Blazers moment).

The NO_DATA collapse from 8,641 → 5,356 (-38%) is the real win: 3,285 editions transitioned out of NO_DATA in 30 minutes, mostly into LOW (with the Item 5 gate downgrading some of those to STALE). The next 24-48h should continue the trajectory as fmv-recalc keeps sweeping at 1,000 historical_fallback rows per tick.

## What's left for the next session

1. **Investigate the new-stub-with-NULL-onchain-ids writer.** 5 new dupes appeared in the 10 minutes after the merge — all with NULL on-chain ids, slipping past the trigger's INSERT predicate. Not blocking, but identifying which writer creates these stubs would clean up the long-tail dupe accumulation. Likely candidate: `topshot-moments-hydrator`, `ensure_topshot_edition_stub`, or a wallet-backfill path.

2. **Watch HIGH count over the next 24-48h.** The fmv-recalc catch-up is rewriting cold-tail-1.0 NO_DATA → 1.7.0 LOW/MEDIUM/HIGH. Some of those will land on HIGH after the serial-residual gate evaluates them (LeBron's 1,126 sales should easily qualify). Expect HIGH to recover above the pre-merge dedup baseline as the catch-up completes.

3. **Trigger eligibility for INSERT-with-NULL-onchain-ids.** Consider whether the trigger should also block UUID-keyed TS edition INSERTs that lack on-chain ids entirely (i.e., become INSERT-time the edition needs to provide a pair OR be rejected). Pro: blocks the stub-creation pattern at the source. Con: legitimate stub paths (new wallet backfill where the edition doesn't yet have on-chain ids known) would break. Investigation needed before shipping.

## Verification queries (for future audit)

```sql
-- TS editions count (expect ~10,966 + small drift from new stubs)
SELECT COUNT(*) FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd';

-- Still-mergeable (expect 0 — writer fix + new trigger holding)
SELECT COUNT(*) FROM editions e1
WHERE e1.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND e1.external_id !~ '^[0-9]+:[0-9]+$'
  AND e1.set_id_onchain IS NOT NULL AND e1.play_id_onchain IS NOT NULL
  AND EXISTS (SELECT 1 FROM editions e2
    WHERE e2.collection_id=e1.collection_id
      AND e2.external_id ~ '^[0-9]+:[0-9]+$'
      AND e2.set_id_onchain = e1.set_id_onchain
      AND e2.play_id_onchain = e1.play_id_onchain);

-- NO_DATA catchable tail (expect monotonic decrease over 24-48h)
WITH latest AS (
  SELECT DISTINCT ON (edition_id) edition_id, confidence
  FROM fmv_snapshots ORDER BY edition_id, computed_at DESC
)
SELECT COUNT(*) FROM editions e
JOIN latest l ON l.edition_id = e.id AND l.confidence = 'NO_DATA'
WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND EXISTS (SELECT 1 FROM sales s WHERE s.edition_id = e.id
                AND s.sold_at >= NOW() - INTERVAL '180 days');
```
