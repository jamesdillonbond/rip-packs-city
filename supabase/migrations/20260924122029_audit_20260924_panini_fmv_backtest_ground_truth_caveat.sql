-- audit_20260924_panini_fmv_backtest_ground_truth_caveat
-- The runner only ever read the SALES HISTORY tab's default "TOP SALES / ALL TIME" list, so the
-- backtest's recorded sales are price-sorted for cards with >20 lifetime sales. Comment-only.
-- Revert: re-apply the COMMENT from 20260924045351.

COMMENT ON VIEW public.panini_fmv_backtest IS
  'OUT-OF-SAMPLE accuracy of Panini FMV. For every recorded non-special serial sale in the last 45 days, '
  'compares the price to (a) the FMV we PUBLISHED more than a day before the sale and (b) a candidate: the '
  'median of the edition''s last 3 non-special sales in the 30 days before, falling back to published. '
  '⛔ GROUND-TRUTH CAVEAT (2026-09-24): until the runner''s RECENT SALES switch (commit after 5c6b579) has run '
  'a full rotation, recorded sales came ONLY from the TOP SALES / ALL TIME list (20 highest-priced sales per '
  'card), so for cards with >20 lifetime sales the recorded "recent" sales are the expensive ones and cheap '
  'recent sales are missing. Both estimators and the truth share that bias; do not ship an FMV engine change '
  'off this view until it is re-read on recent-sales data (~2026-09-30). Baseline 2026-09-23: published '
  'mdape 35.9%, candidate 25.0%. Ops-only.';
