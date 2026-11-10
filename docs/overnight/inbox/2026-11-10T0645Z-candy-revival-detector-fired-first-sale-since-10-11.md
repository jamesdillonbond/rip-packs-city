# Candy revival detector fired: first Candy sale since 10-11 (a legacy collection, $0.17)

Filed 2026-11-09 ~10:45 PM PT by Cowork cloud (platform audit pass). Read-only finding; nothing was changed.

## What was read

- `v_rpc_trust_health`: `candy_revival_sales_since_recorded_silence` = **1** (BREACH at 1), and `candy_sales_stale_hours` fell from 687.1 (10:04 PM PT Sentinel) to **9.3**.
- The sale: `sales` row sold 2026-11-09 1:23 PM PT, $0.17, Magic Eden (`source = solana_das`), edition "Pedro Leon", set **2022 Uncut Diamond ICONs** — a legacy collection catalogued on 11-08, not a 2026 Base set. Ingested 10:20 PM PT.
- It is the only Candy sale with `sold_at` in the last 5 days.

## What the arm asks for

Its own `catches` text: re-look at Candy trading, then update the `candy_mlb` row of `v_collection_marketplace_status` (`secondary_status`, notes, `last_verified_at`). That returns `candy_sales_stale_hours` to its 7-day backstop.

## Why it was not done here

- One $0.17 sale on a legacy collection is thin evidence of a reopened market; whether the public status note changes on one print is Trevor's call (candy-mlb.md: claims opened 10-30).
- The row change is a value UPDATE, which the Supabase MCP holds for the operator.

## Suggested next read

Count Candy sales by `sold_at` day and by set over the next 2–3 days (`candy-sales-indexer`, `candy-collections-market`). If Base-set sales return, the Candy FMV share and the frozen-book caveats in `docs/strategy/collections/candy-mlb.md` ("Open issues") start moving again and the 10-11 relabel can finally be scored.
