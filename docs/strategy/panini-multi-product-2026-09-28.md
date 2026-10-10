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
| pack EV | `panini_pack_ev_board` | ⚠ UPDATED 2026-10-02: 2332 from `panini_pack_ev_model` (FMV-based, v0.5); **2420 (2026 Prizm WNBA) from the SALES model** `panini_pack_ev_model_wnba_2026_sales` (see the 10-02 section below); every other product: NULL EV, `ev_modeled=false`, "not modeled". |

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

## 2026-10-02 (~7:30 PM PT) — WNBA live end to end, tier-1 admission, what the next thread inherits

**State now (verify; these are dated samples):** 53 of 145 known products admitted (`walk_cards=true`) — WC 2332,
the founder's 29, WNBA 2420, and 22 "tier 1" products (≥ 50 active listings; `note` contains
`tier 1 (>=50 active listings)`). ~12k catalogued editions, 0 older than 7 days before tier 1 landed.

What this thread added (each has a ledger entry with its revert path):
- **Discovery:** `?sport=Womens Basketball` is a real grid filter (8 WNBA setIds; `WNBA` is NOT — it serves the
  unfiltered grid). In `PANINI_DISCOVERY_SPORTS` (`app/api/cron/panini-ingest/route.ts`).
- **Bootstrap walk** (`e7fdba7c4`): an admitted product with **0** catalogue rows, on the grid, admitted < 12 h ago
  (`panini_products.walk_cards_since`, stamped by trigger on every false→true flip) narrows the walk-order GET's
  `walk_set_ids` to it, so its fresh cards are walked first instead of queuing behind the held list. Ends by itself.
  Without it, 2420 had 0 rows 3 h after admission; with it, 223 in the first run.
- **Pack EV for 2420 from SALES, not FMV:** the FMV-based view `panini_pack_ev_model_wnba_2026` (gated v0.2) could not
  price the packs (sale-backed value share 10–22%); `refresh_panini_pack_ev_sales_model(2420)` (pg_cron
  `rpc-panini-pack-ev-sales-model`, :46 hourly) fits log(sale) = player + parallel on every sale and feeds
  `panini_pack_ev_model_wnba_2026_sales` → the board. Method, numbers and gates:
  `docs/strategy/panini-fmv-packev-methodology.md` (2026-10-02 sections). First live: FOTL 55/18 vs 150, Hobby 22/9 vs 30.
- **Residential runner hardening:** `scripts/panini-schedule-harden.ps1` (WakeToRun + StartWhenAvailable; Trevor ran it
  10-02) after an overnight sleep killed every residential lane; `.ps1` files must be ASCII or BOM (guard test).

**Open — in order:**
1. **Tier-1 verification** (a fresh-session routine is scheduled for 10-03 ~8:15 AM PT): did the bootstrap give the 22
   rows; did older products stay < 7 days stale. If freshness held → **tier 2** (25 products, 10–49 listings), same
   `update … set walk_cards=true` + note + ledger. Tier 3 (67 products, < 10 listings) only if capacity clearly allows —
   they are near-dead markets.
2. **Pack EV for another product** = new pack pages appear (only WC + WNBA are live drops on 10-02; the home-page
   harvest finds 1 pack link). Reuse the sales model: generalize the family CASE + odds (today WNBA-specific) into a
   per-product config before a second product, don't copy the function.
3. **Naming (step 2 above)** — still needs Trevor's signed-in Chrome; 2420 is the only non-WC product with a name.
4. The board's "typical" for 2420 is the sum of family medians (WC convention); a Monte-Carlo pack median runs higher
   (FOTL ~26 vs 18). Fine as a conservative figure; revisit if the Packs tab copy promises "what the median pack holds".
   **Done 10-03 ~1:20 PM PT:** it did promise that (Packs tab tile + note, and the /insights/panini-squeeze note). Both now
   say what the figure is: each card slot's median card, added up — not a simulated median pack. Number unchanged.


### 2026-10-02 ~11:00 PM PT — tier 1 bootstrapped; walk order now interleaves new and known

- **Bootstrap worked:** the 8:09 PM PT run walked only the 22 (`walk_set_ids` = 22, 4,447 new pskus queued). By 10:50 PM
  every tier-1 product had catalogue rows (1–62 each). Catalogue 12,329, 0 editions older than 7 days, 4,837 older than 4.
- ⚠ **A bootstrap run can log `shuffled (walk-order endpoint unavailable)`.** At 10:00 PM the GET (200) narrowed
  `walk_set_ids` to the 7 products still at 0 rows, so its `pskus` list was legitimately EMPTY. The runner reads an empty
  known list as "endpoint unavailable" and shuffles that run's discoveries. The effect was the intended one (only those 7
  were walked); only the label lies. Not a failure: the GET returned 200 in the Vercel logs.
- **Starvation risk fixed in code (`scripts/panini-walk-order.mjs`):** the runner walked EVERY new discovery before ANY
  known edition. With ~4,400 queued at ~600 a run, that is about a day of zero catalogue refresh. New and stalest-known
  are now interleaved 1:1 after the held-priority list (tests incl. a 4,400-vs-12,000 flood case). **Takes effect only
  after Trevor pulls on the runner box** (`panini-run.bat` does not pull). Until then, the old order still holds.
- Tier 2 remains gated on the morning freshness read (item 1 of the open list above).

### 2026-10-03 ~8:20 AM PT — tier 2 HELD: the runner box has not pulled the interleave

- Walks ran every ~4 h overnight (8:09 PM, 10:32 PM, 2:31 AM, 6:37 AM PT). Tier 1: 1,216 editions across the 22.
  Catalogue 13,181. Stale > 7 d: 0. But > 5 d: 3,704, and the oldest edition was last seen 2026-09-27 2:58 AM PT.
- The 2:31 AM and 6:37 AM runs still logged `stalest-first (… new + … known)` without "interleaved", so the runner box is
  on the OLD walk order. 3,681–5,245 new discoveries per run are walked before ANY known edition, so the known catalogue
  is barely refreshing. **Without a `git pull` on the runner box, editions start crossing 7 days ~3 AM PT 10-04.**
- **Tier 2 held** until the box pulls and a run logs `interleaved` with stale > 7 d still 0. Then admit tier 2 per the
  open list (item 1).

### 2026-10-03 ~9:05 AM PT — server-side fix for the stale catalogue (no runner pull needed)

- The runner box still had not pulled at 8:45 AM PT (last run logged no `interleaved`), with 514 editions > 6 days old.
  The walk-order GET now also puts catalogue editions **older than 5 days** into `priority_pskus` (after the held ones,
  stalest first, **max 300 per run**). Every runner since 09-29 walks that list FIRST, so the stalest editions are refreshed
  ahead of the discovery flood whatever runner version is running. The response reports it as `aged_priority`.
- **Verify on the next run** (the runner GETs at the start of each ~4 h run): in `pipeline_runs` `panini-ingest-enum`,
  `extra.enum.order_mode` should read `… N held-priority + …` with N up to ~300, and editions older than 7 days should stay 0
  past ~3 AM PT 10-04 (the oldest was last seen 09-27 2:58 AM PT).
- After the box pulls (`interleaved` appears) AND stale > 7 d is still 0 → admit tier 2.

### 2026-10-03 ~11:30 AM PT — the 10:00 AM run went silent after its walk-order read; runner now reports hang vs sleep

- The 10:00 AM PT run did its auth preflight (10:00:10) and walk-order GET (10:00:11, 200, the aged-priority response),
  then nothing: no enum marker (the last three runs posted theirs 32-37 min in), no card batch, no request, 85+ min.
  Measured run shape for reference: enum marker ~35 min in, card walk until ~1h50m in (6:00 AM run: 6:37 enum, last
  batch 7:52). The task's 2-hour limit ends a hung run, so the 2:00 PM run is not blocked.
- From the server a HUNG runner (a `page.evaluate` into a frozen tab has no timeout) and a SLEEPING PC are the same silence.
  **Shipped:** `scripts/panini-stall-watchdog.mjs` (armed after the walk-order read). The runner marks progress per
  enumeration step, pack page and card; a 60 s check reports either
  - `stall` — ticks on time, no progress for 15 min (`PANINI_STALL_MIN`): posted as a FAILED `panini-ingest-enum` row
    with `runner hung: … in phase=<enum|packs|walk> (<sport / pack / n of N>)`, then the runner exits 4 so the next run's
    Chrome preflight restarts a frozen browser; or
  - `slept` — the clock jumped > 5 min between ticks: an ok `panini-ingest-enum` row with `extra.stall.kind = slept`;
    the walk carries on.
  Read it: `select started_at, ok, error, extra->'stall' from pipeline_runs where pipeline='panini-ingest-enum' and extra ? 'stall'`.
  **Takes effect when the box pulls** (the runner loads code at run start). No row + silence after a pull = the process
  died or the box was off — neither a hang nor a timer-visible sleep.
- Tier 2 stays held (unchanged condition: a run logging `interleaved` and stale > 7 d still 0).

### 2026-10-03 ~2:00 PM PT — secondary-market packs: the runner now looks for them

- Trevor: "They have plenty of other packs that are selling on the secondary, they just don't have frequent pack drops."
  `panini_pack_pages` held 4 pages (WC Hobby/FOTL, WNBA Hobby/FOTL drops). Pack links were only harvested from the pages
  the CARD walk visits (home page = current drops, card grids = cards), and the 15-slot `packish_unmatched` evidence list
  was filled every run by `/packcard-` CARD links, so a missed pack link could never show.
- Panini 403s data-center traffic (`pg_net` GET of `/marketplace/nfts.html` → 403 block page, 10-03), so the pack
  listing's URL cannot be read from here. **Shipped (`scripts/panini-pack-grid.mjs` + runner step 1.5):** after
  enumeration the runner visits up to 4 candidate pack-listing pages (on-site nav links whose path names a pack
  marketplace, `PANINI_PACK_GRID_URLS`, then the guess `/marketplace/packs.html`), scrolls each, and harvests every
  `/marketplace-details/subpack-<n>-<pack_id>` link (anchors AND raw HTML). Harvested pages go to the registry and are
  opened that run (`getPackMarketStats` → `panini_pack_state`, attributed to a product by name; EV "not modeled").
  `packish_unmatched` no longer keeps `/packcard-` links.
- **Read the answer:** `extra->'enum'->'pack_grid'` on the next `panini-ingest-enum` row — per candidate: HTTP status,
  final URL, scrolls, `subpack_added`, and the `/onepanini` ops it fired. `subpack_added = 0` on every candidate means
  the listing lives elsewhere: read `packish_unmatched` (now real pack-ish links only) and the ops, or set
  `PANINI_PACK_GRID_URLS` on the box once the URL is known.
- Supporting changes: pack pages are served **stalest-walk first** (they were ordered by URL — past the 40-page cap the
  tail would never open); pack type comes from the pack's own name (Blaster / Mega / Premium …, plain "Packs" = hobby —
  WC and WNBA unchanged); the card walk also stops at **110 min of run time** (`PANINI_RUN_BUDGET_MIN`) and the grid step
  has a 4-min budget, so the added pages come out of the walk instead of past the task's 2 h kill.
- Pack EV for these products stays "not modeled" until a product's families are priced from sales (the open item #2
  above — generalize the model per product, don't copy it).

### 2026-10-03 ~3:10 PM PT — CORRECTION: the 10:00 AM run CRASHED (closed Chrome tab), it did not hang

- Trevor read `%USERPROFILE%\panini-run.log` on the box: the 10:00 AM run passed the walk-order read and **exited 1 at
  10:01:33** on `fatal: page.waitForTimeout: Target page, context or browser has been closed` (runner line 662, the
  enumeration loop). The debug Chrome's tab/browser went away under it. Not a hang and not sleep, so the watchdog (which it did not
  have yet) had nothing to report. The "hung vs asleep" framing in the ~11:30 AM section above was a guess from server-side
  silence. **A crash is the third case, and only the box log separates it.**
- The 2:00 PM run is healthy: its first CDP preflight timed out, `panini-run.bat` restarted the debug Chrome, and it was
  working through the grids at 2:51 PM (Soccer, Basketball, Womens Basketball, Football each stopped at their budget). So
  enumeration now runs ~45+ min before the enum marker; silence at 45 min is NOT by itself a fault.
- **Shipped:** the runner survives a closed tab/browser. All 13 `page.waitForTimeout` calls became a plain timer, and
  before every navigation `ensurePage()` returns the same tab if it is open, else a new tab, else (CDP) a fresh connection
  to the debug Chrome, with the capture listener re-attached. Recoveries are counted in `enum.page_recoveries`. Guard:
  `__tests__/panini-runner-survives-a-closed-page.test.ts`. An unreachable Chrome still ends the run.
- Open question for the box: **why** the debug Chrome closed at ~10:01 AM (Chrome auto-update restart, a crash, a window
  closed by hand?). A non-zero `page_recoveries` on later runs says it keeps happening.

### 2026-10-03 ~4:20 PM PT — secondary pack grid WORKS: 64 pack pages found, 40 captured on the first run

- The 2:00 PM run's `enum.pack_grid`: `/marketplace/packs.html` → HTTP 200, **redirected to `?sport=Basketball`**, 9
  scrolls, **64 new subpack pages**; ops `products` ×3, `filters` ×3, `packFiltersMetaTimestamp`. The pack-page walk opened
  40 (the cap) and captured **40 of 40** — `panini_pack_state` 2 → 42 rows, ~15 basketball products (2020-21 Blockchain
  NBA, 2021-22 Prizm, 2021-22 Optic, Best of the NBA 22-23/23-24/24-25, Flawless 23-24, Hoops, Instant, Prizm 23-24/24-25,
  Court Kings, Silhouette). Each carries floor / recent / avg sale, total and unopened supply, and Panini's GUARANTEED
  contents (`raw.pack_label`). All attribute by product name with `product_set_id` NULL → EV "not modeled". Same run: walk
  order `interleaved (4754 held-priority + 5020 new + 17635 known)`, 115 card batches to 3:52 PM PT.
- **Follow-ups shipped:** one listing pass per discovery sport (`/marketplace/packs.html?sport=<sport>`; the bare listing
  serves Basketball only), grid budget 4 → 7 min; pack pages per run 40 → 60 (rotating stalest-first); an un-typed pack is
  labelled **"Pack"**, not "Hobby" (Hobby is claimed only for the modeled standard packs 1038 / 1056).
- **Watch:** floors on thin packs are asks, not values (e.g. a 2022-23 Best of the NBA pack: floor $455,000, recent sale
  $900). The Packs tab shows them as market stats, not EV; any future "cheapest pack" or EV surface must not take a lone
  floor at face value.
- **~4:40 PM PT:** the Packs tab heads an un-typed pack by its own name (37 rows relabelled hobby → pack in the DB).
  **Naming lead:** every secondary pack carries Panini's official product name (`collection_name`). If a pack page's
  responses also reference its cards (`packcard-<setId>_…`, e.g. sneak-peek images), the pack ties to a product set id
  and the product can be named from Panini's own data, without a signed-in Chrome. The runner now records those counts
  in `panini_pack_state.raw.__set_ids` (evidence only). **Next:** read them after the 6 PM run
  (`select id, product_name, raw->'__set_ids' from panini_pack_state where raw ? '__set_ids'`); if one set id dominates
  per pack, have the route set `product_set_id` from it and fill `panini_products.name` where NULL (never overwrite).

### 2026-10-03 ~4:45 PM PT — held cards were starving the aged list; and the walk has a CAPACITY ceiling

- `priority_pskus` = held-uncatalogued THEN aged. Collector walks now name **4,164** held pskus (10 collectors); a run
  refreshes **~290-370 editions** (measured from `last_seen_at` per run hour) — so the 300 aged were never reached and
  editions > 6 d rose 1,113 → 1,350 in two hours. **Shipped:** aged and held alternate 1:1, aged first (route GET,
  live from the next run with no box pull).
- **Capacity:** ~2,000 refreshes/day vs 22k+ catalogue editions (+4,164 held, +5,020 grid-new per run) ≈ an 11-day
  ⚠ **CORRECTED 10-04:** the catalogue is ~15.7k editions (`panini_editions`, 10-04 9 AM PT). "22k+" added the ~4k held cards
  to a walk list (~17.7k) that already contains them, so the 4-hour rotation was ~8 days, not ~11. The decision stands.
  rotation. Keeping every edition < 7 days old is NOT reachable by ordering; the levers are per-card time (~13 s:
  serial paging + SALES HISTORY clicks), more runs, or narrowing which editions must stay fresh (e.g. held + listed).
  **Tier 2 stays held** until that is decided — admitting 25 more products only lengthens the rotation.
- **~5:10 PM PT — Trevor chose "more runs".** Shipped: the walk-order GET serves `run_mode` (`lib/chains/panini/run-mode.ts`):
  **full** at the old 2/6/10 AM-PM PT slots (grids + pack grid + pack pages + cards), **walk** at 12/4/8 AM-PM PT (cards
  only, 105-min walk budget, still capped at 110 min of run time); a bootstrap run and a late catch-up start are always
  full. The runner honours it (old runners ignore it → full). **On the box, once:** `git pull`, then
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\panini-schedule-every-2h.ps1` (changes only the trigger
  interval to PT2H; keeps WakeToRun / StartWhenAvailable / IgnoreNew / the 2 h limit; `-Hours 4` undoes). Expected: ~12
  runs/day, ~2× the card-walk minutes. Measure after a day: editions refreshed per day (`last_seen_at`), and `> 6 d` count.

### 2026-10-03 ~8:10 PM PT — first per-sport pack pass + first WALK run (measured)

- **6:00 PM PT FULL run:** enum marker 6:39 PM, `run_mode=full`, order `interleaved (4464 held-priority + 3541 new + 17635
  known)`, `page_recoveries 0`, no stall. Pack listings: bare (Basketball) +64, **Soccer +34, Womens Basketball +12,
  Football +224, Baseball +11** → registry `pack_pages_new 280` (346 offered); 60 pack pages opened / 60 captured (all
  basketball this time: never-walked pages tie on `last_walked_at` NULL and fall back to url order). Rotation at 60 per
  full run, six full runs a day ≈ one day to open all ~350. 172 batches 6:00 PM-8:05 PM PT; **295 editions refreshed**
  (in line with the ~290-370 baseline; the first walk-only run is the comparison).
- **8:00 PM PT WALK run started on schedule** (`run_mode=walk`, `4325 held-priority + 0 new + 17635 known`, no grid, no pack
  pages) — the box is on the 2-hour schedule.
- **Naming lead: NEGATIVE.** `raw.__set_ids` is `{}` on every pack captured this run — a pack page's /onepanini responses
  carry no `packcard-<setId>_` reference, so a pack cannot be tied to a card product's set id this way. Not building the
  route step. Product naming stays the signed-in-Chrome item (step 2).
- Freshness at 8:06 PM PT: > 6 d **1,655**, > 7 d **0** (the oldest crosses 7 d ~3 AM PT Sunday). Measure the walk-only
  runs' refresh count over the night before judging the 2-hour schedule.

### 2026-10-04 7:15 AM PT — first night on the 2-hour schedule (measured)

- Six runs 8 PM-6 AM PT alternated as designed: walk 8 PM, full 10 PM, walk 12 AM, full 2 AM, walk 4 AM, full 6 AM. Full
  runs post their enum marker 22-39 min in; walk runs at :00. **No stall rows; `page_recoveries` 0 on five runs, 1 on the
  6 AM run** (a closed tab recovered instead of killing the run).
- **Refreshes: 3,063 editions in 11 h (8 PM-7 AM PT) ≈ 280/h ≈ 6,700/day**, vs ~2,000/day on the 4-hour schedule (~3.3×).
  Walk-run hours ran up to 497/h (4 AM); full-run hours dip during their grid phase (60 at 2 AM).
- **Held backlog draining:** held-priority 4,325 → 2,784 over the night (~1,540 newly catalogued).
- **Freshness:** > 7 d **0** through the 3 AM PT crossing (the stalest are reached first). > 6 d rose 1,575 → 2,049: half
  the priority slots still go to held cards, and the cohort last walked ~6 days ago is large. Expect it to fall once the
  held backlog is gone (~a day at the overnight rate), when every priority slot is aged.
- **Packs:** 246 rows — Basketball 63, Football 131, Soccer 29, Womens Basketball 12, Baseball 11. Only 1038/1039/1055/1056
  are `ev_modeled` (the 10-03 view fix); every other pack, incl. 27 more soccer packs, reads not modeled.
- **Verdict:** the 2-hour schedule is enough to keep everything under 7 days. Re-read > 6 d after the held backlog drains;
  tier 2 can be reconsidered then.

### 2026-10-04 ~8:00 AM PT — naming: from collectors' collections (step 2 no longer needs a signed-in Chrome for held products)

- The collector walk reads each profile collection by collection, and a collection IS a product (its `cname` is Panini's
  product name). It now tallies (set id, collection name) over the cards it reads and posts `{product_names}` to the
  ingest route once per walk. The route names a set id only when the top name has ≥ 3 cards and ≥ 80 % of them, and only
  into a NULL `panini_products.name` (never overwrites a hand-set name).
- Reach: every product a walked collector (linked + rotation) holds. A product nobody walked holds stays unnamed.
- **Read it:** `select started_at, extra->'product_names' from pipeline_runs where pipeline='panini-ingest-enum' and extra ?
  'product_names' order by started_at desc` and `select count(*) filter (where name is null), count(*) from
  panini_products`. A product being named also lets its secondary packs attach (`product_set_id` by name); EV stays
  limited to the four modeled packs.

## HANDOFF — 2026-10-04 ~9:30 AM PT (the 10-03/04 thread is archived; start here)

**State (measured 9:11 AM PT 10-04):** 53 of 146 products admitted (`walk_cards`), catalogue 15,669 editions, 4,362
refreshed in the last 24 h, > 6 d 1,830, **> 7 d 0**; walk order `2641 held-priority + 17678 known`; 246 pack rows from
~348 pack pages (100 not yet opened); 144 of 146 products unnamed. All Panini lanes ok in 24 h except two
`panini-collector-walk` partial reads (the by-design 10-min per-profile cap on a 54-collection profile).

**Running unattended (nothing to do unless it breaks):** the box runs every 2 h — FULL at 2/6/10 AM-PM PT, WALK-only at
12/4/8 (`run_mode` in each `panini-ingest-enum` marker); stall watchdog (`extra ? 'stall'`), closed-tab recovery
(`enum.page_recoveries`), per-sport secondary pack listings (`enum.pack_grid`), pack pages stalest-walk first (60 per full
run), aged/held alternating in `priority_pskus`, `panini_pack_ev_board` models only packs 1038/1039/1055/1056.

**Open — in order, each with its read:**
1. **Product names (first pass due with the ~5:45 AM PT collector walk 10-05, if the box pulled `92b4ed6e2`).**
   `select started_at, extra->'product_names' from pipeline_runs where pipeline='panini-ingest-enum' and extra ? 'product_names'`;
   `select count(*) filter (where name is null), count(*) from panini_products`. Spot-check three named set ids: the name
   should match the product of `panini_products.sample` and, where packs exist, `panini_pack_state.product_name`. Nothing
   posted → the box has not pulled, or the walk log lacks `product names: offered …`.
2. **Freshness after the held backlog drains** (held-priority in the latest enum marker → ~0 within ~1 day). Then > 6 d should
   fall (every priority slot becomes aged). **> 7 d must stay 0.**
   ⚠ **"> 7 d" here is WALK age (`panini_editions.last_seen_at`). FMV age is a different number, and the two disagreed on
   10-04** (walk > 7 d 0, FMV > 7 d 39). The gap was a pricing defect, not the walk: a walked card with no sale and nothing
   listed wrote no snapshot, so a delisted ask's ASK_ONLY price stayed current (41 editions, $396k, oldest 241 h). Fixed
   `d730717d6` (10-04 ~10:25 PM PT): those cards now write `NO_DATA` / null FMV. **Read:** `NO_DATA` rows appear after the
   first post-deploy walk (~11:45 PM PT 10-04), and editions with FMV > 7 d but walk < 1 d fall to ~0. Any that remain
   = the fix did not reach them (check their payload's `for_sale_count`).
3. **Tier 2 (25 products, 10–49 listings) — admit only if** > 7 d is 0 and > 6 d is falling with held ~0. Re-derive first:
   refreshes/day (`last_seen_at` by run window) vs catalogue size; tier 2 adds discovery load to FULL runs only. Admit with
   `update panini_products set walk_cards = true where …` + a note per row + a ledger entry; bootstrap narrows the next
   run to products with 0 rows (< 12 h). Tier 3 (67 products, < 10 listings) only if capacity clearly allows.
4. **Pack pages:** all ~348 opened by ~10-04 afternoon; then `panini_pack_state` ≈ pages captured. Football (224 pages) is
   the bulk.
5. **Pack EV beyond the four modeled packs:** needs (a) the product named + admitted + priced, and (b) its pack contents.
   Many secondary packs publish GUARANTEED contents (`raw.pack_label`, e.g. "3 Red Mosaic Parallel NFTs") — deterministic
   slots, so EV = Σ slots × that family's sale-priced value. Generalize `refresh_panini_pack_ev_sales_model` per product
   (config, not a copy) and list each modeled pack id in the board's `model_set_id` (chain-strategy.md rule).
5b. **DECISION FOR TREVOR (filed 2026-10-04 ~11 PM PT): ASK_ONLY prices come from ONE listing, and a few dominate the totals.**
   13 ask-only editions at ≥ $10k sum to **$1.03M, 27% of all Panini FMV dollars ($3.8M)**. Worst: Ousmane Dembélé Tiger
   Stripe /12 (`packcard-2332_486999_12688101_37`) has one listing at $1,000,000 and no sales, so its FMV is
   0.5 × $1,000,000 = **$500,000**. Options: leave as is (the price is labelled ASK_ONLY); cap ASK_ONLY at a multiple of its
   parallel family's sale-backed median; or keep ASK_ONLY prices out of aggregates (pack EV, collection totals). Any
   cap is an engine change (`panini-1.3.0`), so backtest it against `panini_published_fmv_backtest` first. Read:
   `with latest as (select distinct on (edition_id) * from panini_fmv_snapshots order by edition_id, computed_at desc)
   select count(*), sum(fmv_usd) from latest where confidence='ASK_ONLY' and fmv_usd >= 10000`.
   **↳ DECIDED 2026-10-10 ~8:12 AM PT (Claude Code cloud, under Trevor's "make decisions yourself"): NO CAP — leave ASK_ONLY as labelled.** Re-measured: 1,505 ASK_ONLY editions = $1.14M of $4.27M (27 %); 11 at ≥ $10k = $744k; max $500k (the Dembélé /12, unchanged). Proposed cap = K × the parallel family's sale-backed median (family = `packcard-<set>_<parallel>`; HIGH/MEDIUM/LOW editions, n ≥ 3). **Backtest** (ASK_ONLY snapshots in 45 d with a later recorded sale; /1 editions joined on `panini_sales.sku`, others on `edition_external_id`): n = 55, MdAPE uncapped 48.1 %, capped at 10× 50.0 %, at 5× 50.0 %; on the 8 editions a 5× cap would touch, MdAPE 50.6 % → **76.9 %**, and they sold at a median **0.70× the uncapped FMV**, far above the family median. So the family median under-prices the premium cards a high ask sits on, and the cap makes the editions that DO trade worse. The absurd asks ($1M listings) never trade, so nothing measures a cap on them. Revisit only with a different anchor (e.g. same-player sale-backed price), backtested the same way.
5c. **Watch: the 10 PM PT run of 10-04 was killed before it logged a line.** `RPC Panini Ingest` Last Result `-1073741510`
   (`0xC000013A`, console closed or Ctrl+C), with no `run start` in `~/panini-run.log`. Every run 10 AM → 8 PM that day logged start
   and end (`rc=0`). Task Scheduler's Operational log is disabled and the System log is empty 9:50–10:15 PM, so the cause is
   unrecorded. NOT the 10-02 `.bat`-edit hang (tooling-gotchas.md): nothing was running, and nothing edited the `.bat`.
   Recovered by a manual `schtasks /run` at ~11:08 PM PT (healthy: CDP + preflight 202, `complete=true`, full enum, then
   the walk). **If it recurs:** enable the Operational log (`wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true`,
   needs admin) and correlate with a logoff, a Windows Update restart or an interactive console close at that minute.
6. **Not doable from the cloud:** anything about the live site (Panini 403s data-center traffic incl. `pg_net`) — instrument
   the runner and read its marker.

## 2026-10-10 (~4:30 PM PT) — "Do it all": every surface goes all-product (Claude Code cloud)

Trevor asked what Panini could gain from Top Shot's toolset and whether every Panini sport is covered, then: "Do it all."
Measured first (live, ~3:00 PM PT): 149 products seen (Basketball 69, Football 52, Soccer 16, Womens Basketball 8,
Baseball 4), 79 admitted, 24,353 catalogued editions, **> 6 d 0 / > 7 d 0**, 5,854 refreshed in 24 h, 444k sales since
2021-06; HIGH/MEDIUM FMV share by sport: WNBA 44 %, Soccer 35 %, Basketball 23 %, Baseball 17 %, Football 12 %.

Shipped (each in the ledger with its revert):
- **Tier 2 admitted:** the 13 unadmitted products with ≥ 10 grid items (12 Basketball incl. 2023-24/24-25 Best of the
  NBA and 2023-24 Prizm, 1 WNBA) + **2263** (racing; held by the founder, never grid-sighted, inserted). Bootstrap narrows
  the next runs to them. **Read:** `> 7 d` must stay 0; re-check `> 6 d` after two days.
- **"Racing" discovery sport** (unverified value). **Read the next FULL run's per-sport `set_ids`**: if "Racing" serves
  the Basketball setIds, remove it (as "WNBA" was). Other categories Panini may have run (WWE, UFC, college) are NOT
  added — no evidence in RPC's data that they exist on this platform.
- **Sniper = every product** (`panini_deal_board_all`, 798 deals vs 211 WC); WC squeeze board unchanged (same 211, md5).
- **Sets = every product** (`panini_set_progress_all` + `_products`; picker by sport; 1,928 sets, never read past the
  1,000-row clamp).
- **Top Sales board** carries Panini (`v_panini_top_sales`, service-role; merged in `lib/insights/top-sales.ts`).
- **/insights/panini-premiums** — parallel premiums (`panini_parallel_premiums`: base parallel vs the player's most
  common base parallel, HIGH/MEDIUM both sides) + #1 / perfect-mint serial premiums (`panini_serial_premiums`, real
  sales, ≥ 2× the edition median). Jersey-mint left out (a per-sale serial probe cost 400k buffers / 31 s).
- **Pack EV from guaranteed contents** (`panini_pack_ev_guaranteed_slots` → `_guaranteed` → `panini_pack_ev_board`):
  strict parser (count / player / unparsed); slot value = candidates' 90-day median SALE, equal weight, **unsold
  candidates at the slot's lowest sold median** (the first cut averaged only sold editions and showed a +$116 "edge" on
  the WC White Sparkle pack — survivorship). Gate: one print run, ≥ half the candidates sold, ≥ 10 sales over ≥ 3 priced
  editions (single named card: ≥ 5). **23 of 344 packs modeled (was 4); 0 positive rip edges.** The rest say why
  (a choice/range/mixed pool, or too few sales / uncatalogued editions — e.g. NFL Instant's 156 player packs: 10
  catalogued editions).

**Open, in order:** (1) the Racing read above; (2) tier-2 freshness read; (3) per-product Hobby/FOTL odds models for
products with standard packs (the WNBA sales model generalised — config, not a copy); (4) a parser arm for "Either A or
B (#/N)" lines (equal-weight union over both families) once (3) shows the per-family values are stable; (5) 50 products
still unnamed — the collector walk names held ones automatically.
