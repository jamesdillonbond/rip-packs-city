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

2. **Validate**: `python3 eval.py` — fair rolling/holdout CV of the pooled model vs the incumbent
   power-law (both refit per fold). Confirm pooled med-APE < power-law before shipping.

3. **Export + seed SQL**: `python3 export_setonly.py` — writes `model_setonly.json` (global coeffs +
   71 set effects, support≥6) and `setchunk_*.sql`. Apply the model row + set-effect rows, then verify:
   `SELECT count(*), round(sum(effect),5), sum(support_n) FROM serial_fmv_pooled_set_effect` must match
   the printed checksum.

The read path (`serial_fmv_estimate` 8-arg) and tables ship via `supabase/migrations/20260726*`.
`model_df.csv` (raw sales) is intentionally not committed.
