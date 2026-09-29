# Panini multi-product — state and the switch-on checklist (2026-09-28)

Trevor, 2026-09-28: *"We should be adding all of these different leagues, along with the rest of Panini
NFT collections."* This supersedes the product scope of known-issues #64 ("the WC Prizm plane IS the
collection"). WC Prizm (card setId **2332**) was the only product walked until then.

## What exists (all live 2026-09-28 PT)

| layer | object | what it does |
|---|---|---|
| registry | `panini_products` | one row per card product (psku field 1 = setId). The runner reports every setId each sport's grid serves; **`walk_cards=true` is the only switch** that admits a product's cards. Only 2332 is on. |
| registry | `panini_pack_pages` | the pack pages the runner opens each walk; seeded with the 2 WC pages + Trevor's WNBA FOTL link; harvested links are added as `source='discovered'`. `last_walked_at` without `last_captured_at` = that page type never fires `getPackMarketStats`. |
| column | `panini_editions.product_set_id` | generated from `external_id`; cannot drift. |
| view | `panini_wc_editions` | WC editions only. Every WC-only reader reads this (migration `20260929024339` lists them). |
| gate | `/api/cron/panini-ingest` POST | cards / serials / sales (incl. sales history) of non-admitted products are held back, counted in `extra.skipped_by_set`; a registry read failure falls back to 2332 only and fails the run. |
| walk | `/api/cron/panini-ingest` GET | serves `walk_set_ids`, `discovery_sports`, `full_enum_sports`, `pack_urls` to the runner. |
| pack EV | `panini_pack_ev_board` | EV only where `product_set_id = 2332`; other packs: NULL EV, `ev_modeled=false`, "not modeled" on the Packs tab. |

Unverified from any sandbox (Panini is egress-blocked): the marketplace `?sport=` values other than
`Soccer`, and whether `/pack-<name>.html` pages fire `getPackMarketStats`. Read the answers from the
`panini-ingest-enum` markers (`extra.enum.sports[]`) and `panini_pack_pages.last_captured_at`.

## Switching a product on — do these IN ORDER

1. **Capacity.** The residential box walks ~2,800 editions/day (measured 2026-09-24); WC alone is
   5,124. Every admitted product dilutes WC freshness, and the bridge refuses to write once WC's
   45-day stale share passes 1.0% (`sync_panini_editions_to_shared`). Decide the product list with
   Trevor, and re-measure `panini_coverage_summary.pct_editions_stale_45d` a few days after.
2. **Name it.** `update panini_products set name = …, sport = … where set_id = …` (pack payloads are
   linked to a product by `collection_name` = `panini_products.name`, case-insensitive).
3. **Admit it.** `update panini_products set walk_cards = true where set_id = …` — no deploy needed;
   the next walk's GET picks it up.
4. **Before any surface shows it**, decide per surface — none of these is scoped per product yet:
   - Packs tab: its packs show market stats, EV "not modeled", until step 5.
   - `panini_owner_cards` / `panini_profile_holdings` / trophy picker: all-product by design; check
     their links, because edition pages exist only for bridged (WC) editions.
   - `panini_sales_analytics` (another session, 09-28): all-product; confirm that is the intent.
   - Boards, coverage, Sets tab, bridge: WC-only via `panini_wc_editions` — a per-product version
     is new work, not a flag.
5. **Pack EV for it.** `panini_pack_ev_model` is WC's published odds (insert 7/20, FOTL = Hobby + 1
   exclusive). A product needs its own odds (from its `panini_pack_state.raw.pack_label`), its own
   card-family mapping, and priced editions of its own before any EV is published. Then extend the
   `product_set_id = 2332` condition in `panini_pack_ev_board`.
