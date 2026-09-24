-- audit_20260924_panini_recent_sales_fmv_comment_held
-- Corrects the function comment from 20260924121553, which claimed a caller that does not exist yet.
-- Comment-only. Revert: re-apply the COMMENT from 20260924121553.

COMMENT ON FUNCTION public.panini_recent_sales_fmv(text[]) IS
  'Proposed panini-1.1.0 FMV input: per edition id, the median of its last <=3 recorded NON-special serial sales '
  'in the last 30 days (n_recent = how many). NOT YET CALLED by anything: the engine switch (approved 2026-09-23) '
  'is held until panini_fmv_backtest is re-read on RECENT-sales data (~2026-09-30), because recorded sales were '
  'top-sales-only until the runner fix of 2026-09-24.';
