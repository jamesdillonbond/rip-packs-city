# Top Shot ownership index (`topshot_ownership`): how it is fed, what reads it, and its limits

Written 2026-10-17 (Claude Code cloud, session_014vWuubmVKLyyyMQAwWzT2W), after the 10-15 → 10-17 Series 2026-27 readiness work.
⚠ Every number here is a **dated sample (2026-10-17 2:10 PM PT)**. Re-measure before quoting it. The migrations named are the source of truth for each body.

## What it is

One row per Top Shot Moment the index believes is held: `nft_id` PK, `edition_external_id`, `owner_address`, `serial_number`, `source`, `observed_at`, `walk_missed_at`.
It answers "who holds this edition" for the per-edition Top Owners panel, the rookie collector leaderboard, set completers and the squeeze board's concentration ("Top 5 hold").

2026-10-17 sample: 527,228 rows, of which 508,921 have `walk_missed_at IS NULL`. 8,661 owners. By source: `dune` 42,788, `onchain_walk` 484,440.

## Two writers

1. **Dune lane (dead, frozen).** It indexed 39 named sets (`topshot_index_dune_sets`, frozen 2026-10-16). Its rows are kept and re-confirmed or flagged by the walk.
   ⛔ Do not delete them: the Dune route sizes paid walks by `count(source='dune')`.
2. **On-chain walk** — `app/api/cron/ownership-onchain-walk/route.ts`. It is triggered off-repo (not in `vercel.json`), ~every 3 h, `maxDuration` 800, budget 720 s.
   - It walks `get_stale_ownership_wallets(800)`. That function takes the UNION of indexed owners, ordered by `max(observed_at)`, and never-walked candidates, which sort first as `-infinity`. It walks each wallet's ids over Flow REST.
   - **Re-confirms** holdings it finds. **Flags** holdings it did not find (`mark_topshot_ownership_walk_missed`). A row is flagged, never deleted.
   - **Indexes new holdings** for ids at or above `get_topshot_index_walk_id_floor()` (50,688,258) through `topshot_index_walk_holdings(...)`, in 5,000-id chunks.
   - Rule: a held id is indexed when its set is **`set_id_onchain >= 219` AND not a Dune set**.
     - Set 218 (Series 8 Base Set, ~1.54 M minted) is excluded ON PURPOSE: the 98 % census gate could never pass on it from walked wallets.
     - The old "> 265" rule was wrong. Dune covered only 39 sets, so 8 sets were missed until `20261016161353`.
   - Ids it cannot place go to `topshot_index_unmapped_ids` (below).
   - Logs `marked_missed`, `mark_error`, `id_floor`, `index_ids_sent`, `index_written`, `candidates_stamped`, `unmapped_queued`, `index_error`, `budget_hit`, `wallet_errors`.

## `walk_missed_at` — a failed confirmation is not a holding (`20261015200136`)

- Set when a walk of `owner_address` did not find the Moment (traded in, burned, moved).
- Trigger `trg_topshot_ownership_walk_missed_clear` clears it on re-confirmation (newer `observed_at`) or on an owner change.
- **Every holdings reader must filter `walk_missed_at IS NULL`.** `20261015200615` did this for `get_edition_top_owners`, `topshot_rookie_collector_leaderboard_mv` and `topshot_set_completers_mv`. A new reader that forgets it counts traded-in Moments.
- The one-off backfill (17,512 rows) is archived in `flowty_archive.audit_20261015_ownership_walk_missed`. It excluded the 10-10 re-attribution stamps (1,523 rows) that would otherwise have been mis-flagged.

## Discovery — which wallets get walked

The walk only knows wallets that are already indexed or in `topshot_ownership_walk_candidates` (`owner_address`, `source`, `added_at`, `last_walked_at`).

| feed | job | window | source value |
|---|---|---|---|
| daily backstop | pg_cron 737 `17 9 * * *` (2:17 AM PT) | 60 d | `pack_opener` / `marketplace_buyer` |
| hourly | pg_cron 740 `41 * * * *` (`20261017172020`) | 2 d | same |
| one-off 10-17 | `20261017184739` | since 2025-09-01 | `series8_era_backfill` (7,455) |

- Both seeders call `seed_topshot_ownership_walk_candidates(p_days)`. It reads `pack_rips.opener_address` and `sales.buyer_address` for Top Shot and skips wallets already indexed. Cost at 2 d is ~0.3 s / ~12 k buffers.
- ⚠ **The blind spot:** a wallet that never opened a pack or bought on the marketplace inside the windows (gift-only, or quiet since before 2025-09) is never walked.
  The 10-17 backfill closed the Series 8-era part. ~30 % of those wallets hold anything indexable, so the gain is ~1 k rows per 800-wallet run.
- Capacity: ~800 wallets × ~8 runs/day ≈ 6,400/day, against a 400-day peak of 1,259 distinct pack openers in a day.

## Unplaced ids → hydration (`20261016161027`, `20261017161643`, `20261017172228`, `20261017182508`)

- `topshot_index_walk_holdings` maps an id through the daily id map (`topshot_moment_id_editions`) OR `moments`. Anything else is queued in `topshot_index_unmapped_ids` with the wallet that held it.
- **Prediction:** `topshot_index_unmapped_predict(5000)` (pg_cron 739, `1-56/5`). Ids mint in contiguous per-edition batches, so if both nearest mapped neighbours are in the same set, the id is in that set.
  Measured on 3,000 hydrated ids: 0 false positives, 99 % recall for set 218.
- **Dispatch:** `topshot_index_unmapped_dispatch(60)` (pg_cron 738, `2-58/4`). It skips ids predicted into a set the index does not cover, sends predicted-indexable ids first, and still sends unpredicted ones.
  It uses the existing chain hydrator: same Cadence script, `topshot_moment_hydrate_requests`, drained by `topshot_moment_hydrate_tick` (no per-tick cap).
- **Cost model.** The dispatch SELECT scores every candidate before its top-N sort, so its cost does NOT depend on `p_max`: ~155 k buffers whether the limit is 40 or 120.
  The three stock counts (`backlog`, `skipped_predicted_uncovered`, `unpredicted`) cost ~1.15 M buffers, so they run only on the :02 and :30 ticks. Other ticks log them as NULL, never 0.
  ⛔ Read pgss blocks/call before changing this lane's cadence (the 10-17 9:24 AM revert).
- **Flow:** 60-request bursts at minute 2 mod 4; the other Flow script bursts sit at 1 and 3 mod 4. 24 h before the raise: 0 `http_429`.
- 10-17 sample: 205,932 queue rows; actionable backlog ~23 k; ~166 k skipped as predicted-uncovered. One walk adds ~2 k actionable ids, so a backlog that stops falling between walks is the signal to revisit the rate.

## Readers and their honesty gates

- **Squeeze board concentration:** `refresh_topshot_edition_concentration_v2` (pg_cron 682, `58 2,8,14,20` UTC). It counts walk-confirmed rows only and live supply = circulation − burned.
  An edition with an incomplete census is retired by UPDATE: `census_complete=false`, shares NULL, rendered "—". 10-17 sample: 3,981 rows, 2,272 census-complete.
- **Player page Top Collectors:** carries a coverage note from `get_topshot_rookie_index_coverage(text)` via `lib/entity/index-coverage-note.ts`.
- **Rookie collector leaderboard / set completers:** MVs filter `walk_missed_at IS NULL`. The rookie list is `topshot_2025_rookie_players`, a VIEW over Series 8 sets named Rookie Debut / Origins / Rookie Revelation / 2025 Rookie Ultimates.
  ⚠ The 2026 class does not exist yet: its Rookie Debut drops 2026-11-11. Build the 2026 list from Series 9 rookie sets once they mint; do not seed it from the draft or the four announced partners.
- **Top Shot's own accounts are not collectors (`20261020222700`).** `topshot_rookie_collector_leaderboard_mv` and `get_edition_top_owners` exclude every address in `flowty_excluded_addresses` (pack distribution `0xb6f2…`, buybacks `0xe1f2…`/`0x4d2c…`, routing). Before: the PDS account (22,718 Moments, zero lifetime trades) was rank 1 on 39 of 61 rookie boards. Guard: `__tests__/top-collector-boards-exclude-top-shot-system-accounts.test.ts`. Resolve through the registry; add a newly found Dapper account THERE, never as a literal in a reader.
- **Supply and rank reads (`20261020222800`, service role):** `get_topshot_supply_breakdown(player, set, series)` — per edition minted / burned (Atlas, NULL = not reported) / live / locked / Top Shot-held / collector-held / collectors / census_complete (index within 98–102 % of live). `get_topshot_player_rank_thresholds(player)` — value and Moment count of the 1st/3rd/10th/26th collector on a 2025-rookie board. Both are internal: the second is an FMV proxy, not Top Shot's locked-TSS rank (see the ⚠ below).
  10-20 cross-check: Series 8 Rookie Debut Standard, Atlas burned 8,206 of 61,000 vs 8,213 walk-missed rows — two independent sources within 7. Locked (Atlas): 26,109 of 52,794 live.

## Series 2026-27 (on-chain series 9) readiness — checked 2026-10-17

- **Labels:** `9: "Series 2026-27"` in every repo series map, guarded by `__tests__/topshot-series-maps-agree-on-the-newest-series.test.ts`.
  `topshot-set-series-onchain` registers a new series in `collection_series` only when `SERIES_DISPLAY` knows it, and fails the run otherwise.
  ⚠ Live `collection_series` labels 6/7/8 still read "Series 5/6/7" (the open two-convention question, known-issues inbox 2026-08-18); 9 will read "Series 2026-27". `series-param.ts` resolves both.
- **Circulation:** `topshot_normalize_circulation` corrects only Series 8 families.
  ⛔ Do NOT extend it to 9: its Family B floors to 1,000, and 2026-27 Rookie Debut is /500.
  Series 9 is capped by the trigger's Atlas branch, re-applied hourly by `sync_topshot_base_circulation_from_atlas` (job 457). On 10-17, 0 base editions in any series read above Atlas.
- **New-set frontier:** `20261015201733`. The Atlas editions dispatch probes set ids above the max known every 10 min.
- **Inert, left alone:** `upsert_challenge_from_gql` defaults a slot's `series` to `'8'`, but nothing reads `challenge_slots.series` (pg_proc + repo grep, 10-17).

## Top Shot 2026-27 reward mechanics that map onto this index (blog, 2026-10-14/16)

- **Blue Chip /3** (top 3 per All-Rookie player) and **Rookie Yearbook /26** (top 26 per rookie): snapshot one week after the All-Rookie teams.
- **Squad Goals /10:** top 10 per team, snapshot July 1, playoffs and Finals count.
- **Constellations /99 and /10:** All-Star trade-ins, which burn Rares from the current AND earlier seasons.
- **Signature Style /49:** trade-in auctions.
- Partnered athletes (10-17): Dybantsa, Peterson, Boozer, Wilson. The scarcest parallel of their Moments is signed. Signed editions are in `editions.autographed_at` since 2026-10-19 (Atlas `autographedAt`, daily sweep); partner status itself is not stored.
- ⚠ **Do not publish an RPC rank as if it were Top Shot's.** Historically Top Shot ranked by locked Top Shot Score (purchase price or ASP × 10), and the 2026-27 scoring is unpublished.
  The defensible RPC product is "cost to climb into the top N", which needs the official scoring (asked of Trevor 10-17).
