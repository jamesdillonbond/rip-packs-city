# Big-spender watch — internal intel (2026-11-27)

Trevor, 2026-11-27: *"We should start tracking any wallet that has hit any of our top sales. If someone is spending big money on any of the collections, we should be keeping an eye out for them."* Then: *"We don't need to put this user-facing. We just need to gather intel from this."*

**Public surface: `/insights/whales` (Whale Watch), added the same afternoon** (Trevor: "Maybe we should have a page that has this. Like a whale watcher page" → "this page can be user-facing"). The page, `/api/public/insights/whales` and `/api/og/insights/whales` read ONE precomputed row, `whale_watch_board`, through the service role (`lib/whale-watch-board.ts`). Every table here stays RLS-on with no anon/authenticated grant, and every function is SECURITY DEFINER with EXECUTE for `postgres` / `service_role` only (verified with `has_function_privilege` on 2026-11-27).

The board snapshot is precomputed because reading the activity live costs ~32 s over 30 days. `refresh_whale_watch_board()` (pg_cron **954** `rpc-whale-watch-board`, hourly at :27, ~16 s; migration `20261127234801`) writes 25 leaders for each of 7d and 30d, whale buys ≥ $250 in the last 7 days, and the 30 days' 15 biggest buys. It counts **buys only** and leaves out trades between a reciprocal pair (two wallets that have each bought a top sale from the other). Public names: the username, or a shortened wallet marked "…" (`whaleName`). The internal `reciprocal_flag` is never shown.

Follow-up `20261128013007` (same evening, "Keep going"): every leader and move carries `key` (the wallet key or Panini username) and every leader carries `top_collection`, so a name links to that collection's wallet page via `whaleHref()` → Top Fans' `topFanHref()` (`rel=nofollow`). `by_collection` holds each collection's own top 10 for 7d / 30d. The page shows them as collection chips, so Panini's six-figure prints don't drown Top Shot. A collection with no whale buys in 30 days (Golazos and UFC on 11-27) gets no chip. Refresh time stayed ~9–16 s.

Follow-up `20261128015710`: every move carries `link_key`, so the bought item links to its page through `whaleItemHref()`. That is the edition page (`editionRouteHref`, which sends Pinnacle to `/pinnacle/moment/<render id>`), or for a pack its detail page `/<collection>/pack/dist/<dist id>` (never the simulator). Candy packs have no page and stay plain text. One live sample of each kind returned 200 with its real title on 2026-11-27. /insights/top-sales now links to Whale Watch from its "What this board is" note.

**Naming unnamed whales** (`20261128021720`): 66 of 404 Flow whales had no username and had never been asked about. `run_big_spender_usernames()` (pg_cron **958**, every 10 min) sends up to 25 of them per run, biggest spenders first, to Atlas through the shared `member_wallet_username_requests` lane. It waits whenever that lane has a request in flight, so the lane's request rate never doubles. Job 650 (`resolve_member_wallet_usernames_via_atlas`) writes the answers to `wallet_usernames`, and the next run copies them into `big_spender_wallets`. Solana (Candy) wallets have no username source and stay shortened.

## What counts as a top sale

One of a collection's **25 highest sales in its Pacific-time calendar month**, **$100 minimum**. Items (Moments / Cards / Pins) and packs are ranked separately. Rank rather than a dollar bar because "big" differs by an order of magnitude between collections. 90-day p99.9 on 2026-11-27: Top Shot ~$305, All Day ~$100, Panini ~$1,234, Candy ~$1,380.

Sources:

| source | collections | note |
|---|---|---|
| `sales_market` | Top Shot, All Day, Golazos, UFC, Candy | |
| `pinnacle_sales` | Disney Pinnacle | |
| `panini_sales` | Panini | buyer is a USERNAME, not an address |
| `candy_pack_sales` | Candy packs | |
| `pack_purchases` | Flow packs | `event_kind='secondary_sale'` only; `custom_id 'nba'` (Top Shot's own shop) excluded |

Excluded buyers: `flowty_excluded_addresses` (the system-account registry) plus the three marketplace addresses `get_whale_watch_7d` already drops. Keys: a Flow address is lower-cased; a Solana address and a Panini username are kept as-is (both case-sensitive).

## Objects

- `big_spender_wallets`: one row per tracked buyer. **Sticky:** a wallet is never removed once tracked. `reciprocal_flag` = a top-sale counterparty also bought a top sale from this wallet (possible circular trading). `is_internal` = an `internal_accounts` wallet. `muted` / `note` are for manual triage (`get_big_spender_activity` skips muted and internal wallets).
- `big_spender_top_sales`: the ledger of qualifying sales. PK `(source, sale_ref)`, plus `month_rank` and `item_label`.
- `refresh_big_spender_wallets(p_days int default 45)`: deletes and re-ranks every PT month from `now() - p_days`, then upserts wallets. Logs `big_spender_refresh` to `pipeline_runs` (success only).
- `get_big_spender_activity(p_hours int default 24, p_min_usd numeric default 0)`: every buy and sell by tracked wallets in the window, with username, item label, price and counterparty.
- `get_big_spender_summary(p_days int default 7)`: one row per active tracked wallet with buys, spend, sells, sold, net, biggest buy, collections and last seen.
- `big_spender_item_label(...)`: Top Shot labels carry the series first ("S1 Metallic Gold LE", "2025-26 Rookie Revelation") via `series_display_label()`.
- pg_cron **953** `rpc-big-spender-refresh`, `23 1,7,13,19 * * *` UTC. Cadence-watched (`pipeline_cadence_watchlist`, 720 / 1440 min).

## Reading it

```sql
-- who spent the most this week
select * from get_big_spender_summary(7) limit 25;
-- last 24 h of moves at $250+
select * from get_big_spender_activity(24, 250);
-- the lifetime board
select username, top_sale_count, top_sale_usd, biggest_sale_usd, collections, reciprocal_flag
  from big_spender_wallets order by top_sale_usd desc limit 50;
```

Refer to wallets by `username` in anything written for Trevor. 393 of 573 had one at the first fill; Panini keys are usernames already. Candy (Solana) wallets have none.

## Known traps

- **Panini six-figure prints are largely circular.** spinotron, redwolf66sports, MrFourToEight, RaspySlabs, Adlcards and others trade the same cards with each other at $100k–$210k. They dominate any dollar ranking; read `reciprocal_flag` before calling any of it demand.
- The ledger re-ranks the open window, so a sale can drop out of a month's top 25 when bigger ones arrive; its buyer stays tracked.
- **Wallet keys go through `big_spender_key()`** (2026-11-27, `20261128024418`). Some `pinnacle_sales` rows store a Flow address without `0x`; before the fix 23 Pinnacle whales were tracked under that bare key and labelled Solana. Any new source added to the three functions must wrap its buyer and seller in `big_spender_key()`. Never lower-case a Solana key; the helper leaves base58 untouched.
- `get_whale_watch_7d` is a different, older instrument: a rolling 7-day volume read over Flow sales only, with nothing persisted. This watch does not replace it.

## First fill (2026-11-27 ~3:30 PM PT)

1,777 top sales since 2025-11-01, **573 wallets** (393 named, 19 reciprocal, 0 internal). In the 7 days before, the wallets made 4,877 buys ($134k) and 5,655 sells ($52k). Biggest Flow move that week: cmnkb8, three Rookie Debut Cases at $2,020–$2,199.

## Revert

```sql
-- the public board first
select cron.unschedule('rpc-whale-watch-board');
delete from pipeline_cadence_watchlist where pipeline = 'whale_watch_board';
drop function public.refresh_whale_watch_board();
drop table public.whale_watch_board;
-- then the tracker
select cron.unschedule('rpc-big-spender-refresh');
delete from pipeline_cadence_watchlist where pipeline = 'big_spender_refresh';
drop function public.get_big_spender_summary(integer);
drop function public.get_big_spender_activity(integer, numeric);
drop function public.refresh_big_spender_wallets(integer);
drop function public.big_spender_item_label(uuid, integer, text, text, integer);
drop table public.big_spender_top_sales;
drop table public.big_spender_wallets;
```
