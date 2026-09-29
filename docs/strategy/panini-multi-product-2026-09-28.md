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

## 2026-09-28 (~11:31 PM PT) — 29 products admitted for a linked collector; the pricing bridge is the open item

**What changed.** Trevor approved admitting every product a linked RPC collector holds (his own
Panini username, `jamesdillonbond`, linked for the trophy case). `walk_cards=true` was set on 29
`panini_products` rows: 1579 1584 1587 1602 1613 1631 1632 1705 1759 1779 1780 1783 1784 1819
1820 1940 1941 1942 1959 1989 2053 2063 2077 2115 2120 2145 2217 2260 2305. Their `note` says why.
Their grids list ~3,150 items (`last_grid_items`, 2026-09-29 05:20 UTC). A 30th held product,
2263 (racing), has no registry row yet (never sighted), so it is not admitted.
Steps 2 (naming) and 5 (pack EV) of the checklist above were **not** done: names are unknown from
here, and pack EV stays "not modeled".

**Freshness baseline, before the flip** (`panini_coverage_summary`, 2026-09-29 06:30 UTC):
edition age p50 20.8 h, p90 40.4 h, max 44.8 h; stale 45d 0.0%; walked 7d 100%.
Expected: the WC cycle stretches from ~1.8 to ~3 days (2,800 editions/day capacity). **Re-measure
in 2–3 days**; if `pct_editions_stale_45d` moves off 0 or p90 passes ~96 h, narrow the list
(`update panini_products set walk_cards=false where set_id in (…)` — no deploy).

**The open item — a per-product pricing bridge.** Admitting only COLLECTS: cards, serials, sales.
No FMV reaches these products, because the bridge into shared `editions` / FMV
(`sync_panini_editions_to_shared` and its readers) is WC-only via `panini_wc_editions`. The trophy
slab reads FMV as `editions` → latest `fmv_snapshots` for `collection_id = Panini`, and
`get_user_top_owned_moments`' Panini branch does the same, so **once non-WC editions land in
`editions` with FMV snapshots, Panini trophies and the picker price with no further change.**
Needed: (a) bridge admitted non-WC editions into `editions` (Panini `collection_id`,
`external_id` = psku) with its own staleness gate (the current 1.0% gate is WC's), and (b) an FMV
computation over `panini_sales` for them, with confidence from sale count. First consumer: slot 2
of `/profile/jamesdillonbond` (Rayan Rupert, 1941, #1/1 — a 1/1 will stay thin on sales; LOW or
NULL is the honest answer there).

## 2026-09-28 (~11:50 PM PT) — the per-product pricing bridge is BUILT

`sync_panini_products_bridge()` (migration `20260929064132`; pg_cron `rpc-panini-products-bridge`
at :24/:54 as `cron_heavy`; pipeline `panini-products-bridge`, on the cadence watchlist at `info`).
It bridges every admitted NON-WC product into `editions` / `sets` / `players` / `fmv_snapshots` /
`edition_fmv_current`. The WC bridge and its 1.0% gate are untouched.

- **Freshness is per edition:** walked within 45 days or not bridged (`stale_skipped` counts them).
- **Sets are namespaced** `panini-p<setId>-<slug>` and named "<product> · <set>" ("Panini product
  <setId> · …" until the registry names the product; the name follows the registry on the next run).
- **Players** share WC's `panini-<slug>` namespace, insert-only; an ambiguous slug is never linked
  (`player_slug_collisions`).
- **FMV** is the ingest route's existing panini-1.1.0 snapshot for each card, copied as the WC bridge
  copies it.

It writes nothing until the 29 products' cards arrive (first walk after 2026-09-28 11:31 PM PT). Proven
in a rolled-back transaction; see the migration header. Still open from the list above: **naming**
(needs `panini_products.sample`, i.e. a walk on a runner that has pulled `e8c76f4d2`) and **pack EV**.

### 2026-09-29 11:46 AM PT — held-edition queue: served, not yet reached

- The walk-order GET now serves the linked founder's held, uncatalogued editions: the 10:35 AM PT
  run's `known_order` was 5,776 (catalogue ~5,624 at start + his held pskus), up from 5,458.
- **None walked yet (0 of 136 catalogued / bridged / priced; trophy slot 2 still no FMV).** Cause:
  the runner walks brand-new GRID discoveries before the known list (3,900 new this run, 1,464 and
  3,044 the two before), and one ~4 h run walks ~660 editions (197 in its first 71 min). The held
  pskus sit at the FRONT of the known list, so they are reached once a run's new discoveries fall
  under its capacity — the admitted products' grids are finite (~3,150 listed items), so that
  pool drains within roughly a day of runs.
- Not changed: making held pskus jump the new discoveries is a runner edit, and the box only runs
  new runner code after `main` is pulled there (`panini-run.bat` never pulls), so it would not land
  sooner than the drain.
- WC freshness (`panini_coverage_summary`): p50 20.8 h → 27.3 → 29.5 → **33.0 h**, p90 40.4 → 46.8
  → 49.0 → **52.5 h**, stale-45d still 0.0%. Drifting as predicted while new products are
  enumerated; the narrow-the-list trigger (p90 ≈ 96 h or stale-45d > 0) is not near.
- 12:00 PM PT 09-29: unchanged (0 of 136 walked; p50 33.2 h / p90 52.7 h / stale-45d 0.0%). The Oct 1
  check is now a suggested task in the Claude app ("Check Panini held editions got walked and
  priced") — a scheduled fresh-session routine here cannot carry the Supabase connector.
