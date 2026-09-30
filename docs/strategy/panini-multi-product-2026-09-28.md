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

### 2026-09-29 12:40 PM PT — follow-up check (run early; scheduled for Oct 1) + held-priority runner fix

Read at 12:10–12:40 PM PT 09-29 (about 2 days before the planned Oct 1 check; no runner run since 10:35 AM PT).

- **(A) Held editions: 0 of 136 walked.** Distinct `psku` in `panini_user_holdings` for `jamesdillonbond`: 136. With a
  `panini_editions` row: **0**. Bridged into `editions` (Panini collection): **0**. `edition_fmv_current.fmv_usd > 0`:
  **0**. Trophy slot 2 (`packcard-1941_377959_9989801_273`, Rayan Rupert #1/1): `held_state=held`, **`fmv` NULL**, as
  expected with no catalogue row (and a 1/1 with no sales may stay NULL after it is walked; that is not a defect).
- **(B) Last 3 enum runs, `order_mode`:** 10:35 AM PT `stalest-first (3900 new + 5776 known)`; 6:21 AM PT
  `(1464 new + 5458 known)`; 2:25 AM PT `(3044 new + 5126 known)`. The "new" pool is **not draining.** It rose to 3,900
  as the enumeration reached further into the admitted products' grids (14,040 grid items that run). One ~4 h run walks
  about 660 editions. The 11:46 AM PT note's "drains within about a day" assumed ~3,150 listed items, but one run
  already had 3,900 new ones, so that estimate is not safe.
  **Fixed (runner + route):** the walk-order GET now also serves the held pskus as their own list, `priority_pskus`.
  The runner (`scripts/panini-walk-order.mjs`, `buildWalkOrder`) walks them **before** the fresh grid discoveries, so
  the 136 go first in the next run. This could not be done from the list alone because the runner derives "fresh"
  as grid minus list. An older runner ignores the field and keeps the old order. The enum telemetry now records
  `priority_order`, and `order_mode` reads `(N held-priority + …)`. **The fix takes effect only after `git pull` on
  Trevor's box** (`panini-run.bat` never pulls). The route half is live after this deploy.
- **(C) World Cup freshness:** p50 **33.9 h**, p90 **53.4 h** (max 57.8 h), stale-45d **0.0%** (5,126 editions, 100%
  walked in 7 d). Series: 20.8/40.4 → 27.3/46.8 → 29.5/49.0 → 33.2/52.7 → 33.9/53.4. Nowhere near the p90 ≈ 96 h /
  stale-45d > 0 trigger, so the admitted list stays as it is. Walking 136 held editions first delays the World Cup
  rotation by about a fifth of one run.
- **(D) Trophy "Not in saved wallets" marker:** `wmc_clean_walks` has the 5 Flow collections only (Top Shot 67
  wallets, All Day 58, Pinnacle 44, UFC 36, Golazos 31; no Candy). Newest walks are 12:37 PM PT and oldest are
  2:00 AM PT 09-29. `held_state` over all trophies of the 7 users with pins: **20 held / 1 unknown / 1 not_held**,
  unchanged from the 09-29 baseline. The not_held is still Top Shot 974422 (verified sold 09-12). The unknown is
  All Day 2131556 (never checked). **No new not_held, so nothing needed hand-verifying.**
- **12:55 PM PT — landed on both halves.** Production deploy of `main` (8452bf769, which contains the fix) is READY.
  The live GET returns `priority_pskus`: **152** (every walked collector's held, uncatalogued pskus in admitted
  products, not only the founder's 136), `complete=true`, and slot 2's psku is among them. The box's checkout
  (`%USERPROFILE%\rip-packs-city`, which `panini-run.bat` runs from) was clean and was fast-forwarded to 8452bf769,
  so the **2:00 PM PT** scheduled run is the first to use the new order.
- **2:33 PM PT — confirmed in production.** The 2:00 PM PT run logged `walk order = stalest-first (152 held-priority +
  2929 new + 5995 known); 8924 pskus queued` and began card posts at about 2:32 PM PT. One minute in: **6 of 136**
  held editions have a `panini_editions` row (was 0). None were bridged or priced yet, and Rupert's psku had no row
  yet. At ~660 editions per ~4 h run, all 152 priority pskus should be walked within about an hour. Bridging and FMV
  follow on the pricing bridge's own schedule.
- **3:48 PM PT — drained.** The 2:00 PM PT run ended at 3:48 PM PT (rc=0; 650 of 8,924 walked, 646 captured). The
  founder's held editions: **135 of 136** are catalogued, bridged into `editions` and have `fmv_usd > 0`. The one left is
  `packcard-2263_…` (set 2263). Set 2263 is **not an admitted product**, so the route correctly never queues it. Trophy
  slot 2 (Rupert #1/1) now shows **$25, confidence LOW** (floor NULL), labelled honestly.

### 2026-09-29 ~4:15 PM PT — where this thread leaves the switch-on checklist

- **Step 2 (naming): still open. It needs Trevor, not code.** All 30 admitted products now have `panini_products.sample`,
  but 29 have `name` NULL. **No recorded source carries the product name.** Every stored `panini_card_serials.raw`
  row for the 29 has the Panini API's `collection` / `year` / `sport_name` keys set to **null**. The only product
  names in the DB are from pack pages (`panini_pack_state.product_name`: World Cup + WNBA only). The public card
  detail page shows nothing without a sign-in. So naming is: open one sample psku per set in the signed-in Panini
  Chrome, read the product title, then `update panini_products set name = '<title>', sport = '<SPORT>' where set_id = …`.
  Names must match the pack payload's `collection_name` exactly (case-insensitive) if a pack of that product is ever
  captured. Do **not** derive names from the sample's `cardset` (that is the parallel, e.g. "Base Prizms Silver",
  not the product). Until then these cards display as "set <id> · …", which is honest.
- **Step 5 (pack EV):** still "not modeled" for the 29. It needs each product's published odds. No change.
- **Pricing depth:** of the founder's 135 priced held editions, **31 are HIGH/MEDIUM** and 104 LOW (Rupert #1/1: $25
  LOW, floor NULL). The next pass should check whether the LOW ones have captured sales/listings the model isn't
  using. Diagnose before changing anything.
- **Set 2263** (the founder's one unpriced edition) is not admitted; admitting it is Trevor's call (step 1 capacity).
