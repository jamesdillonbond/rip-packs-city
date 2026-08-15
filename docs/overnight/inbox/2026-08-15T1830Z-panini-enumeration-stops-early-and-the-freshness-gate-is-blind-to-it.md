# Panini ingest: enumeration stops early, throughput down ~6×, and the freshness check is blind to it

**Filed** 2026-08-15 ~11:30 PT (18:30Z) from the scheduled `panini-freshness-check`.
**At filing time nothing had been changed** — no code, no DB, no cron.

**STATUS UPDATE 2026-08-15 ~15:00 PT — partially resolved. See §9 before reading §6.**

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

## 9. STATUS — what has since shipped (2026-08-15 ~15:00 PT)

**Telemetry (§6, third bullet) — SHIPPED by a separate session, refactor `d5919b6b`.** Both halves are in place, verified by reading the current file rather than trusting the handoff:

- Runner computes `enumStats` (`enum_stop`, `enum_iters`, `enum_ms`, `grid_pages`, `grid_items`, `wc_pskus`, `wc_share_pct`, `dom_added`) and posts it *before* the card walk, so it lands even if the walk is later killed.
- ⚠ The load-bearing detail: `post()` previously opened with `n` summed from cards/packs/serials/sales and `if (!n) return;`, which would have **silently dropped every enum-only payload** — leaving exactly the symptom of a working route with no real rows, indefinitely. The guard was correctly widened to `if (!n && !payload.enum) return;`. Anyone touching `post()` must preserve that.
- Route side is proven by two direct probes (`enum_stop` = `probe` / `postdeploy-probe`). ⚠ **Those probes exercise the route only** — the runner→route path had not executed in a real walk as of this writing.

Also taken: the §6 interim band-aid, bounded — `PANINI_ENUM_STABLE` 5→8, `PANINI_ENUM_MAX_ITERS` 80→200, plus a new `PANINI_ENUM_BUDGET_MIN` (default 10 min). ⚠ That budget is 20% of the 50 min walk budget; raising it trades directly against card-walking time, so past a point the answer is the §6 preferred fix, not more patience.

**The §5 gap is now instrumented.** `wc_share_pct` measures walk-wide WC share, which is the depth measurement §7 says I could not take. Compare it against the 48% page-1 static scan: materially lower means dilution deepens with depth and the cardset filter is justified on evidence rather than guessed at. The cardset filter itself was deliberately NOT taken — the URL param name is unestablished and guessing it in production ingest is the risk that made this filing hold off in the first place.

**The gate (§1) — FIXED in the `panini-freshness-check` scheduled task.** Added:

- **Escalation 2, a relative throughput check** on `panini_fmv_snapshots`, comparing each complete day against its trailing-7 average. ⚠ It judges **yesterday, never today**: the check runs at 11am PT with only the 02/06/10 walks in, so grading a partial day against full-day averages would fire every morning. Back-tested — healthy days read 84–138% of trailing-7 and the collapse days 35 / 28 / 22%, so the 55% threshold separates them with a wide margin and **would have fired on the morning of 08-14, two days before this was actually caught.** Deliberately relative, not absolute, because the catalogue grows and any fixed target goes stale (the mistake the previous gate made in the other direction).
- ⚠ A caveat that a sustained collapse **depresses its own baseline** — `trailing7` has already decayed 877 → 710 — so a long outage eventually looks normal. Compare against the ~800 healthy-era figure too.
- **Query 3 replaced**: zero-day detection now uses inter-walk gaps from `pipeline_runs_daily` (indefinite retention) instead of grouping `last_seen_at`, with the last-write-wins trap written out.
- **Query 5 added** to read the new enum telemetry, with the three readings (`budget` / `stable`+low `wc_pskus` / no rows at all) mapped to their causes, and probe rows excluded.
- **Case E re-worded** — it no longer asserts "died at the CDP step". That was wrong on 08-13: the PT 08-13 22:00 walk matched the signature having already enumerated 42 grid pages.
- **Case A annotated** so a `✅` can never stand alone through a throughput collapse again.

Both new queries were executed against prod before shipping, not just written.

**Still open:** the §6 preferred fix (cardset filter) — now justified on evidence, see below.

⚠ **CORRECTION (2026-08-15 ~14:50 PT): the first genuine enum row ALREADY EXISTS, and the read instructions this paragraph used to carry would have missed it three ways over.**

- **It is not in the DB.** The runner generated it and wrote it to the local backup (`panini-capture.jsonl`, line 435 of 438) at ~14:29:28 PT — but the route deploy had not landed yet, so the old route saw a payload with no cards/packs/serials/sales and logged it as `skip:"empty"` under `panini-ingest`, **discarding the enum payload**. `panini-ingest-enum` holds only the two manual probes. So one of the five `skip:"empty"` rows previously read as "preflight" is in fact the enum row being destroyed — and `post()` returns early on a genuinely empty payload, which is the tell that those rows are not what they look like.
- **The read path is wrong.** The pipeline is **`panini-ingest-enum`**, not `panini-ingest`, and the fields nest one level down: **`extra->'enum'->>'enum_stop'`**, not `extra->>'enum_stop'`. A top-level read returns NULL on every row and reads exactly like "the telemetry never shipped."
- **The walk was NOT broken.** It enumerated 82 grid pages / 2,460 items / 536 WC pskus and captured cards normally. The 5 editions is the per-batch write, not the walk's reach — so the "if 18:00 also shows preflight rows with no cards, the refactor broke the walk" test would have raised a false alarm.

⚠ **The §5/§7 gap is CLOSED, and it supports the cardset filter.** Measured walk-wide: `wc_share_pct` **21.8%** against the 48% page-1 static scan — **WC share less than halves with depth**, which is the dilution §5 predicted and the depth measurement §7 said it could not take. `dom_added: 0` on a real headful walk, so the DOM fallback genuinely contributes nothing (§7 was right to refuse that conclusion from the backgrounded tab; it is now measured).

⚠ **`enum_stop` does not agree with its own constant — do not trust it as the primary diagnostic until reconciled.** The row reads `enum_stop:"budget"` with `enum_ms: 360553` (6.0 min), but the committed default is `PANINI_ENUM_BUDGET_MIN || 10` and no override exists in `.env`, `.env.local` or `panini-schedule.bat`. 360,553 ms fits a **6-minute** budget to within 553 ms, so a 6-min value was in force at walk time (an uncommitted probe value, or a Task Scheduler env). **A stop reason that disagrees with its own budget is the instrument-lies class this filing is about** — reconcile before reading `budget` as meaningful.

**Full row, for the record:** `enum_stop:"budget" enum_iters:129 enum_ms:360553 grid_pages:82 grid_items:2460 wc_pskus:536 wc_share_pct:21.8 dom_added:0 walking:536 file_fallback:1`. Against the pre-fix 11–42 page range the band-aid is working, and because it stopped on **time** rather than on stability, **536 is a floor, not the full set**.

## 10. Why the runner fix was not shipped at filing time (kept for the record)

The sandbox is down with the documented `/sessions` disk-full (failed identically twice, so I stopped retrying per its own guidance). No `node --check`, no test walk. Current state is degraded-but-working; a syntax error in `ingest-panini-runner.mjs` is total Panini ingest loss. Shipping an unmeasured fix for a mechanism I have not fully confirmed is the exact failure this repo keeps paying for. Next walk is 14:00 PT.
