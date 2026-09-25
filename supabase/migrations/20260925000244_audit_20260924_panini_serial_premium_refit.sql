-- audit_20260924_panini_serial_premium_refit
-- Refit of the Panini special-serial premiums (panini_serial_premium, read by
-- panini_serial_premium_mult() -> panini_deal_board / panini_special_serials_board; no app reader).
-- Method: median of (special-serial sale / median non-special sale of the SAME edition within +/-30
-- days, >=3 baseline sales), 120-day window, measured 2026-09-24 ~5 PM PT. The 07-16 fit was n=37-45
-- against edition FMV; this is n=408-584 against same-edition, same-period sales.
--   jersey mint  1.40 -> 1.43 (n=547, IQR 0.99-2.33)
--   perfect mint 1.21 -> 1.25 (n=408, IQR 0.94-1.85)
--   number 1     1.11 -> 1.50 (n=584, IQR 1.00-2.50)  <- was understated ~35%
-- Baseline sales are partly TOP-SALES-list captures (pre-09-24), biased high, so these are floors.
-- Revert: set multiplier back to 1.40 / 1.21 / 1.11 (fitted_n 40 / 37 / 45).

UPDATE public.panini_serial_premium SET multiplier = 1.43, fitted_n = 547,
  note = 'refit 2026-09-24: median special-serial sale / median non-special sale of the SAME edition within +/-30 days (>=3 baseline sales), 120-day window; IQR 0.99-2.33. Was 1.40 (n=40, 07-16, vs edition FMV).'
 WHERE flag = 'jersey mint';
UPDATE public.panini_serial_premium SET multiplier = 1.25, fitted_n = 408,
  note = 'refit 2026-09-24: same method; IQR 0.94-1.85. Was 1.21 (n=37, 07-16).'
 WHERE flag = 'perfect mint';
UPDATE public.panini_serial_premium SET multiplier = 1.50, fitted_n = 584,
  note = 'refit 2026-09-24: same method; IQR 1.00-2.50. Was 1.11 (n=45, 07-16) — understated by ~35%. Baseline sales come partly from the TOP-SALES list (pre-09-24 capture), which biases the baseline HIGH, so all three are likely floors.'
 WHERE flag = 'number 1';
