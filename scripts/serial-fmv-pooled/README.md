# Top Shot pooled serial-FMV model — offline refit pipeline

Reproducible fit for the pooled multi-factor special-serial FMV model.
Design + validation: `docs/models/topshot-pooled-serial-fmv-2026-07-26.md`.

## Steps

1. **Extract** modelable TS special-serial sales into `model_df.csv` with columns
   `edition_id,price,base_fmv,conf,premium,y,log_fmv,log_circ,bucket,tier,set_id,player_id,set_name,player_name,sold_at`.
   - #1 sales: `sales WHERE serial_number=1` (uses the serial index) over the last ~3y, canonical
     int-keyed editions (`external_id ~ '^[0-9]+:[0-9]+$'`).
   - perfect sales: drive from `editions` with a LATERAL into each year partition using the
     `(edition_id, serial_number, nft_id)` partial index (`serial_number = e.circulation_count AND nft_id IS NOT NULL`).
   - `base_fmv` = latest HIGH/MEDIUM `fmv_current` per edition; drop editions without one.
   - `premium = price/base_fmv`, `y = ln(premium)`.

   Also extract `jersey.json` = `{edition_id: jersey_number}` from
   `editions WHERE collection_id=<TS> AND jersey_number IS NOT NULL` (drives the jersey-#1 double-special).

2. **Validate**: `python3 eval.py` — fair rolling/holdout CV of the pooled model vs the incumbent
   power-law (both refit per fold). Confirm pooled med-APE < power-law before shipping.

3. **Export + seed SQL** — `python3 export_v12.py` fits the **current LIVE production model** (v1.2.0 =
   set-only + 180d recency weighting + jersey-#1 double-special) and writes `model_v12.json` (model row +
   71 set effects, support≥6) + `vchunk_*.sql`. Needs `model_df.csv` + `jersey.json`. Apply the model row +
   set-effect rows, then verify `SELECT count(*), round(sum(effect),5), sum(support_n) FROM
   serial_fmv_pooled_set_effect` matches the printed checksum (n=71, sum_eff=-0.27374, sum_sup=1264 for the
   2026-07-26 fit).

### Version history (each `export_*.py` reproduces its model JSON exactly)
- `export_setonly.py` → `model_setonly.json` — v1.0.0, set-only, unweighted (first ship).
- `export_final.py`   → `model_final.json`   — v1.1.0, adds 180d recency weighting.
- `export_v12.py`     → `model_v12.json`     — **v1.2.0 (LIVE)**, adds the jersey-#1 double-special.

Badge and player factors were evaluated and rejected (redundant with `set` / don't generalize) — see
`docs/models/topshot-special-serial-trends-2026-07-26.md`.

The read path (`serial_fmv_estimate` 8-arg) and tables ship via `supabase/migrations/20260726*`.
`model_df.csv` (raw sales) and `jersey.json` are intentionally not committed (regenerate per step 1).
