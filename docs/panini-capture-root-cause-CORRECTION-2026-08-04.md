# CORRECTION — the Panini `getCardMarketStats` root cause is wrong; three of four "lost" fields are not lost

**Date:** 2026-08-04 PT (2026-08-05 UTC) · **By:** Claude Code, interactive
**Supersedes the MECHANISM in:** `claude/panini-capture-root-cause-2026-08-05.md`, the handoff §1, and the `catches` text shipped in `audit_20260805_panini_sale_price_capture_arm_corrected_owner`.
**Does NOT overturn:** that the defect is ours to look at, or the `breach_at`, or the rename.

---

## TL;DR

| claim | verdict |
|---|---|
| "`getCardMarketStats` is never intercepted — 0 occurrences" | **FALSE.** 2,412 occurrences, HTTP 200, on 787 of 795 detail pages, across all 5 captured runs. |
| "`cards` is empty on every batch" | **FALSE.** `panini_editions` is written to the second of the last capture. |
| "the walk abandons each page at ~3.6 s, before the op fires" | **Moot** — the op fires *within* the dwell. |
| "`price_usd` — live ask prices are being lost too" | **FALSE.** Composition shift, not loss. Priced serials/day are at a window high. |
| "`best_offer_usd` degraded 12.8% → 17.1% null" | **FALSE.** Same composition shift; absolute count 732 → 7,224/day. |
| "`last_sale_usd` collapsed" | **TRUE. This is the one real defect, and it is still open.** |

**Do not ship any of the four fix candidates.** They target a mechanism that does not exist. Candidate 2 ("floor the dwell") would have multiplied walk cost against a 4× larger psku list to fix nothing.

---

## 1. `getCardMarketStats` fires on every page

Both capture generations are on Trevor's box (this is the residential runner box):
`panini-ops-capture.jsonl` (9.7 MB) + `panini-ops-capture.jsonl.1` (26 MB) = **32,615 ops**, five runs, 2026-08-04 09:16 → 2026-08-05 01:41 UTC.

```
run_start(UTC)        dur_min  lines  detailPages   CMS  CMS_non200  pskuList
2026-08-04T09:16:33      18.8   4590          351   350           0       338
2026-08-04T13:00:05      36.6   7975          600   597           0       570
2026-08-04T17:00:07      26.5   6830          504   507           6       467
2026-08-04T21:00:06      35.1   7036          505   501           1       486
2026-08-05T01:00:08      41.7   6184          459   457           0       438
```

`getCardMarketStats` totals **2,412 by `operationName`** and **2,397 by `data_keys`**; raw substring match across all 32,615 lines: **2,412**. Of 795 distinct `marketplace-details` pages, **787** carry a `getCardMarketStats` response in their key union.

The prior finding reported a slice of ~2,748 ops / 196 pages / 11.9 min. **No run in the capture has that shape** — the smallest is 351 pages / 18.8 min. The zero was measured on a subset that is not in the on-disk evidence.

## 2. Why `item_counts: 0` is not evidence of an empty response

Every `getCardMarketStats` row reads `item_counts: {"getCardMarketStats": 0}`. That is a **null instrument**, not a finding:

```js
function findItems(o, depth, out) {
  if (!o || typeof o !== "object" || depth > 5) return;
  if (Array.isArray(o.items)) out.push(...o.items);   // <-- counts ONLY `o.items`
  for (const k in o) { const v = o[k]; if (v && typeof v === "object") findItems(v, depth+1, out); }
}
```

`getCardMarketStats.data` is a flat object with no `items` array, so `0` is the *only* value it can ever take, full payload or not. Compare `getPskuTotalCardsList`, whose products live under `data.products` — also `{}`/0. Neither op can report a non-zero count here. (Same class as memory `rows-written-zero-is-a-null-instrument`.)

## 3. The write path is live — `cards` lands

```
panini_editions: 4,320 rows
  last_update  2026-08-05 01:41:47.201+00   <-- same second as the final capture
  updated  6h   557
  updated 24h   828
  player_name NULL 0 · for_sale_count NULL 0 · thumbnail_url NULL 4 · serial_low_ask NULL 1
```

`player_name`, `for_sale_count` and `thumbnail_url` are fed from the `cards` leg. If `cards` were empty on every batch since 07-27, these could not be current. They are.

## 4. The SPA still asks for every "missing" field

The live `getPskuTotalCardsList` request payload (captured 2026-08-05T01:41:47Z) requests all 45 fields **including all sixteen** said to have been dropped — `athlete`, `cardset`, `rarity`, `year`, `sport_name`, `image_url`, `collection`, `genesis_year`, `inventory_count`, `burned_count`, `burnt_percent`, `burnable_count`, `pan_video_link`, `auto_accept`, `brought_at_price`, `brought_at_time`.

So "we stopped asking for it" is also **false**. We ask; a subset returns null. Note the variables: `wallet_address: ""` and `applied_filters: "...&owner=&listType=all_cards&sortBy=new"`.

## 5. The decisive table — counts, not rates

```
day     captured  price_real  price_null%  lastsale_real  offer_real  editions
07-24      1366        1366         0.0            491        1093       577
07-25       525         525         0.0            239         494       208
07-26      1315        1315         0.0            494        1117       427   <-- DOM harvest lands
07-27      2542        1184        53.4            335        2347       405
07-28      4257        1028        75.9             46        3797       330
07-29      4906         915        81.3              0        4383       329
07-30      4344         920        78.8              0        3777       317
08-01      5346        1362        74.5              6        4290       355
08-03      9451        2023        78.6            198        8317       522
08-04      8239        1934        76.5             87        6116       454
08-05      8865        2038        77.0             79        7224       438
```

- **`price_usd` is not being lost.** Priced serials/day: 514–1,366 before, 613–2,038 after — the last three days are the **highest in the window**. The null *rate* rose only because the denominator tripled. Pre-07-27 read **0.0% null** because enumeration was **listing-gated**: it only ever saw listed cards, which by construction have an ask. The 07-26 DOM harvest (`16a600e63`, `9bd991b3c`) deliberately ended that gating — the null-rate rise **is the coverage fix working**, and it is the same listing-gated bias CLAUDE.md calls the Panini go-live blocker.
- **`best_offer_usd` is not being lost.** 732 → 7,224/day.
- **`last_sale_usd` IS lost.** ~494/day → **0** for three straight days → partial recovery to ~80–200 while captured volume rose 6×. The absolute count collapsed, so this one is *not* a denominator artifact. **Owner still unresolved.**

## 6. Consequences

1. **The `is_listed` fix (2026-08-04) is not contaminated.** Its denominator shift is the intended enumeration widening, not a defect. The 34.5%-carry-an-ask figure stands as an honest measurement of *all* cards rather than *listed* cards. It does **not** need re-deriving.
2. **The arm's `catches` text is now known-wrong** in prod — it directs the reader to "restore the catalog-detail fetch," which would chase a live, working fetch. Correcting it is a third rewrite of the same text in 24h and is left for Trevor's call (see the ledger entry).
3. **`last_sale_usd` remains genuinely open**, and is the only thing that should be worked.

## 7. Reproduce

Run from the repo root on the residential runner box (the capture files are gitignored and live there):

```bash
node scripts/analysis/panini-ops-analyze.mjs panini-ops-capture.jsonl panini-ops-capture.jsonl.1  # op + data_keys census
node scripts/analysis/panini-ops-runs.mjs    panini-ops-capture.jsonl panini-ops-capture.jsonl.1  # per-run segmentation
```
plus the two SQL blocks in §3 and §5.

## 8. `last_sale_usd` — cohort-controlled, and it IS a real loss

Follow-up the same session. `last_sale_usd` maps from `raw->>'brought_at_price'` (with `'0'` treated as not-supplied — see `v_panini_serial_sale_field_supply`).

I first suspected this too was composition: `sku` sets show **zero** overlap between the pre-07-27 era (6,462 skus) and post-08-01 (33,910), which looked like the walk had simply rotated onto different editions. `sku` grammar is `packcard-<setId>_<parallelSetId>_<cardId>_<playerId>__<serial>_<cap>`, and the eras do sample different parallel sets.

**That hypothesis is dead.** Grouping by parallel family and comparing only families present in BOTH eras:

| parallel_set | pre-07-27 supply | post-07-27 supply |
|---|---|---|
| 486953 | 46.3% | **0.5%** |
| 486965 | 42.3% | **0.6%** |
| 486967 | 45.8% | **1.7%** |
| 492193 | 41.9% | **0.5%** |
| 486956 | 23.7% | **1.4%** |
| 486966 | 20.8% | **0.1%** |
| 486964 | 19.6% | **0.5%** |
| 487000 | 18.0% | **1.9%** |
| 486954 | 17.1% | **1.6%** |

Same editions, same families, **~30× collapse across every one**, with `brought_at_price` **key-present on 100% of rows in both eras**. Coverage rotation is ruled out. This is a genuine loss and the only Panini defect worth working.

**Mechanism — best supported, not proven.** The response DTO for `getPskuTotalCardsList` changed for the *same* editions: post-switch rows carry `token_id: ""` (key present, empty) where pre-switch rows had it absent/null. The live request sends `applied_filters: "...&owner=&listType=all_cards&sortBy=new"` with `wallet_address: ""`. The consistent reading is that the **`all_cards` bulk variant returns a leaner projection** — every serial, but without per-serial purchase provenance — where the previous listing-scoped variant returned full provenance. That would explain all four observations at once: the 1.3k→16.2k volume jump, the `price_usd` rate shift (composition), the `brought_at_price` collapse (leaner projection), and `token_id` lighting up (chain fields in the bulk variant).

**Not provable from here.** Both on-disk capture generations post-date the switch, so there is no pre-07-27 request payload to diff `applied_filters` against. Settling it needs a live A/B on the residential box: load one detail page and compare the `getPskuTotalCardsList` payload across `listType` values. That is interactive operator work, not a blind fix — and note that until it is settled, **nobody should "restore the catalog-detail fetch"**, because the catalog fetch (`getCardMarketStats`) is demonstrably alive and well.

## Durable rule

The prior doc's own rule — *diff the whole populated-key set before naming an owner* — was right, and was applied to a field set while the **op census** and the **absolute counts** went unchecked. Two additions:

- **A rate is not a loss.** When a collector's coverage deliberately widens, every "% populated" metric falls without a single row being lost. Check the numerator in absolute terms before calling it an outage.
- **Before concluding an op never fired, confirm your counter can see it.** `item_counts` structurally cannot report non-zero for either of these two ops; a 0 there means nothing.
