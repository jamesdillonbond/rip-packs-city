# Handoff 2026-06-14 — Per-serial FMV layer, Phase 1 (read-only) SHIPPED

Executes Item 2 of `docs/handoff-2026-06-13-top-sales-and-serial-fmv.md`. Trevor approved building **Phase 1 only** (the read-only multiplier table + internal validation — no user-facing number, no edition-FMV change) and left the cap to CC's judgment. Item 1 (the `/insights/top-sales` surface) shipped separately in commit `b623be2`.

## What shipped (DB, via `apply_migration` `serial_fmv_multipliers_phase1_readonly`)

Internal-only, additive, **not wired to any edition-FMV write**. Three objects:

1. **`public.serial_fmv_multipliers`** — the artifact. One row per `(collection_id, serial_bucket, tier, circ_band)`. Columns: `sample_size, median_premium, multiplier (median clamped to [1.0, cap]), is_reliable (sample_size >= min_sample), computed_at`. RLS ON, **no policies** → service_role only; anon/authenticated grants REVOKEd.
2. **`public.compute_serial_fmv_multipliers(p_collection_id, p_min_sample=8, p_cap=60.0, p_lookback_days=180)`** — SECDEF, service_role-only. DELETE-then-INSERT for the collection. Estimator = **median** of `(sale_price / edition_median_sale_price)` per bucket, over editions with ≥10 sales in the lookback (stable per-edition median). Writes both the specific `(tier, circ_band)` cells and the `('ALL','ALL')` per-bucket aggregate.
3. **`public.v_serial_fmv_first_validation`** — read-only (security_invoker), service_role-only. For every actual **#1 sale** in the last 90d: predicted = `edition_median × most-specific-reliable-#1-multiplier` (falls back to the aggregate, then 1.0), vs the actual sale price, with abs % error.

**Buckets:** `first` (serial 1) · `perfect` (serial = circulation_count) · `low` (2–10) · `normal` (>10). **circ_band:** ultra(<100) · low(<500) · mid(<2500) · high(<10000) · mass(≥10000). TS only for now (collection_id `95f28a17-…`).

## Why median + min-sample + a high cap (the cap decision)

Measured premiums vs edition median (TS, ≥10 sales/180d): #1 **mean 41.9× but median 16.6×**; perfect mean 15.9× / median 7.8×; low mean 7.0× / median 3.0×; normal 1.7× / median 1.0×. The **median collapses the outlier skew by construction** — a single $5k-of-$100 #1 sale can't move it — so it is the estimator. `min_sample=8` drops thin cells to `is_reliable=false` (they fall back to the aggregate). The cap is only a backstop against a thin-but-just-reliable cell; set to **60×** after Phase-1 validation showed the reliable COMMON buckets genuinely sit at 38–52× (see below) and a 25× cap was clipping them.

## Phase-1 finding (the reason this is validation-first)

The #1 premium is **strongly inverse to base value** — exactly why tier×circ_band granularity is required and a single global multiplier would misprice both ends:

| tier · circ_band | n | median #1 premium |
|---|---|---|
| COMMON · high (2.5k–10k) | 135 | **51.8×** |
| COMMON · mid | 153 | 38.3× |
| COMMON · mass (≥10k) | 22 | 36.6× |
| FANDOM · mid | 40 | 21.5× |
| RARE · low | 160 | 5.45× |
| LEGENDARY · ultra (<100) | 75 | **2.56×** |

A $1 common's #1 sells for ~$50 (huge multiple); a $1k Legendary grail's #1 sells for ~$2.5k (small multiple). Collectors pay closer to a *fixed-ish dollar* #1 premium on cheap items, a smaller multiple on already-expensive grails.

**Validation (cap=60, 517 #1 sales, last 90d):** median abs error **45.5%**, p75 73.4%, 283/517 (55%) within 50%. Context: edition-FMV alone (multiplier 1×) would mispredict a #1 by ~95% (#1s sell at 16–50× the edition median), so the layer takes #1 prediction from ~95% → ~45% median error — a clear directional win, while honestly still noisy (a given #1 can sell anywhere from baseline to a moonshot).

## Recompute / inspect

```sql
SELECT public.compute_serial_fmv_multipliers();              -- defaults: min_sample 8, cap 60, 180d
SELECT * FROM public.serial_fmv_multipliers WHERE tier='ALL' AND circ_band='ALL' ORDER BY multiplier DESC;
SELECT count(*), round(percentile_cont(0.5) WITHIN GROUP (ORDER BY abs_pct_error)::numeric,1) AS median_err
  FROM public.v_serial_fmv_first_validation;
```
Recompute weekly (the handoff's cadence) once Phase 2 is approved — no cron wired yet (Phase 1 is a static, on-demand artifact).

## Phase 2 (NOT built — needs Trevor's go-ahead; it makes a number user-facing)

Surface `serial_adjusted_fmv = edition_fmv × multiplier` as an **additive secondary line** on the moment page (kind='moment') with its own confidence — never overwriting edition FMV. Before exposing: (a) extend validation to the `perfect`/`low` buckets, (b) decide the confidence rule (e.g. only show when `is_reliable` and edition FMV is HIGH/MEDIUM), (c) consider a per-edition floor so the serial line can't fall below edition FMV, (d) decide whether to widen beyond TS. The roadmap also defers until the tshb sales-history base is fuller (more serial-diverse sales → tighter multipliers).

## Revert

Fully additive, zero edition-FMV dependency:
```sql
DROP VIEW IF EXISTS public.v_serial_fmv_first_validation;
DROP FUNCTION IF EXISTS public.compute_serial_fmv_multipliers(uuid,integer,numeric,integer);
DROP TABLE IF EXISTS public.serial_fmv_multipliers;
```
