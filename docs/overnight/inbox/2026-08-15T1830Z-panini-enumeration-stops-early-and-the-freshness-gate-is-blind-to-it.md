# Panini ingest: enumeration stops early, throughput down ~6×, and the freshness check is blind to it

**Filed** 2026-08-15 ~11:30 PT (18:30Z) from the scheduled `panini-freshness-check`.
**Nothing was changed.** No code, no DB, no cron. This is a filing, not a ship.

---

## 1. The headline: throughput collapsed ~6× and is still falling

Editions priced per day (PT), from `panini_fmv_snapshots`:

| window | editions/day |
|---|---|
| 07-31 → 08-11 | 629–965 (avg ~800) |
| 08-13 | 299 |
| 08-14 | 224 |
| 08-15 | 153 |

Monotonic decline, not a step. `panini-ingest` batches/day tell the same story: ~1,080–1,572/day on 08-08→08-11, then 190 / 204 / 116 / 233.

⚠ **The freshness check passed this as `✅ Panini fresh`.** Its gate is "≥3 walks fired and productive," which is true and says nothing about volume. The gate was deliberately moved off an absolute edition-count threshold because that cried wolf almost daily — it has now swung to the opposite failure and cannot see a 6× collapse. **Fixing the gate is part of this item**, not a footnote: a throughput-delta check (today vs the trailing 7-day median, on `panini_fmv_snapshots`) would have caught this on 08-13.

## 2. It is NOT degraded capture — the runner is healthy per unit of work

`editions_per_batch` is flat across the entire window: **2.16 – 3.11**, on 08-15 exactly as on 08-08. `rows_found_per_batch` likewise flat at 70–88. Zero failed batches — `fail_count = 0` every day; every row `ok: true`.

So auth is fine, pages render fine, per-card capture is unchanged. There are simply far fewer cards walked.

## 3. Walks end cleanly, well under budget — they exhaust the psku list

`WALK_BUDGET_MS` is 50 min. Recent walks run **1.5–13 min**. They are not timing out.

They also are not crashing: the loop posts a full batch at `>= BATCH(60)` and flushes the remainder at the end, and the final batch of nearly every walk is well below that walk's own average (51 vs 78, 44 vs 75, 41 vs 76, 51 vs 85). That is the remainder-flush signature of the loop completing. A crash leaves the remainder unposted.

Therefore `pskus.length` — the enumerated set — has shrunk.

## 4. Enumeration is stopping early. This is proven.

From `panini-ops-capture.jsonl` on the box. The grid op's wire name is **`products`** (the code comments call it `getMarketPlaceList`; grepping for that name finds nothing — naming artifact, not a finding).

- **Every `products` response returns exactly 30 items.** Never a short final page.
- `current_page` increments cleanly (…3, 4, 5, 6…). Pages are distinct and sequential; nothing is re-fetched.
- Stop depth **varies arbitrarily between walks: 42, 11, 12, 18, 15 pages.**

A grid that had genuinely run out of cards would stop at roughly the same depth every walk and end on a partial page. Instead the runner quits at a different arbitrary depth each time while the server is still serving full pages. **There is more inventory available every time it stops.**

➡ **"Fewer cards are listed" is ruled out.** This is premature termination.

## 5. Most likely mechanism: the grid is ~half non-WC product

The scroll loop exits after 5 consecutive iterations that add no new psku:

```js
for (let i = 0; i < 80 && stable < 5; i++) { /* scroll, wait 1200ms, harvest */ }
```

The stability check counts only **WC-Prizm** pskus (`packcard-2332_`), but the page being scrolled is the **unfiltered** `marketplace/nfts.html?sport=Soccer` grid, which the code's own comments note "mixes >=5 products."

Measured live on 2026-08-15, page 1 of that grid: **27 pskus, of which 13 are setId 2332 (48%)**; the other 14 are setIds 1672, 1733, 1792, 1827 (×6), 1971 (×4), 2291.

So the stability heuristic is evaluated against a stream that is roughly half noise. Five consecutive pages of other soccer product end the enumeration regardless of how many WC-Prizm cards lie deeper. As non-WC soccer inventory grows, WC cards are pushed deeper and the walk gets shorter — which matches the observed *progressive* decline exactly.

**Status: strongly supported, not proven.** See §7 for what I could not measure.

## 6. Recommended fix

**Preferred — filter at the source.** Scope the grid to the WC Prizm cardset so every page is WC cards and the stability heuristic means what it says. The `applied_filters` / `p=` params are already in the request the SPA sends, and the runner's own discovery notes reference "the marketplace grid WITH a cardset filter applied." This removes the dilution instead of tolerating it.

**Interim band-aid — raise `stable < 5` and the 1200 ms wait.** String-safe and bounded by the existing `i < 80` cap (worst case ~2–3 min of enumeration, against 37 min of currently-unused walk budget). But it only buys depth; it does not fix dilution, and it degrades again as inventory grows.

**Regardless — make this observable in the DB.** Post `pskus.length` into `pipeline_runs.extra`. The one number that answers this question currently lives only in a console line (`enumerated N WC-Prizm pskus`) and in a local JSONL that rotates on a size cap. That is why this went unnoticed for days. Two-sided change: runner **and** `/api/cron/panini-ingest`.

**And fix the gate** (§1) so throughput regressions page.

## 7. Limitations — what I could not establish, and one retraction

- ⚠ **RETRACTED mid-investigation:** I ran a scroll-and-count experiment in a Chrome tab and recorded new pskus flatlining while the grid kept height. The tab was `document.hidden === true` — backgrounded, so timers throttle and lazy-load/IntersectionObserver is suppressed. That trace measured the instrument, not the grid, and is **not** evidence. The §5 setId mix is a static HTML scan and does not depend on scrolling or timers, so it stands.
- For the same reason I cannot claim anything about `harvestDomPskus` (path b). Card images were `fetching_asset_placeholder.gif` in my hidden tab, so `img[src*="packcard-"]` found ~0 — but that is very likely the backgrounding, not the runner's headful Chrome. **Do not read this as "the DOM harvest is dead."**
- I could not measure the WC share at *depth* (only page 1). That is the remaining gap in §5. A foregrounded browser, or the runner's own `dom_pskus_harvested` / `enumerated N` diag line, would close it.
- ⚠ **Crafted GraphQL against `/onepanini` returns HTTP 426.** I re-derived this dead end that is already documented in `docs/handoff-2026-07-19-panini-catalog-and-candy-offers.md`. Don't repeat it — read that handoff first.
- The ops-capture file only reaches back to **2026-08-14T01:19Z** (size-capped, rotated), so there is **no healthy-period enumeration baseline** in it. The 42-page walk (PT 08-13 22:00) is the closest thing to one.

## 8. Two side findings

**a. Real zero-days, confirmed by a method that works.** No walks at all on **PT 08-06** and **PT 08-12** — 39.6 h and 37.3 h inter-walk gaps, from `pipeline_runs_daily.first_run_at`/`last_run_at`. PT 08-14 had a 22.9 h gap (only 2 walks, both after 20:53). Laptop sleep.

⚠ The freshness check's Query 3 **cannot** establish this. It groups `panini_editions.last_seen_at` by day, and that column is last-write-wins — an edition re-walked later vanishes from the earlier day's bucket. UTC 08-13 shows 22 editions against 497 actually written that day. It is not "editions walked"; it is "editions whose most recent walk was that day," and it understates every day. **Use inter-walk gaps.**

**b. The Case E signature is not reliable as written.** The check treats a 1-row, 0-edition walk as "preflight only → died at the CDP step." The PT 08-13 22:00 walk matched that signature but had already enumerated **42 grid pages** — it got well past CDP and died later. Re-word Case E, or it will misdirect.

**c. Rotation starvation.** `panini_coverage_summary.oldest_family_refresh_h` = **689.6 h (28.7 days)** vs newest 1.2 h. The public board's ≥48 h banner is disclosing honestly, but this worsens as throughput falls.

## 9. Why nothing was shipped

The sandbox is down with the documented `/sessions` disk-full (failed identically twice, so I stopped retrying per its own guidance). No `node --check`, no test walk. Current state is degraded-but-working; a syntax error in `ingest-panini-runner.mjs` is total Panini ingest loss. Shipping an unmeasured fix for a mechanism I have not fully confirmed is the exact failure this repo keeps paying for. Next walk is 14:00 PT.
