-- 24/24 columns verified identical (zero name, zero type mismatches) before the swap —
-- CREATE OR REPLACE VIEW cannot rename or reorder and fails 42P16 on drift.
-- ⚠ WITH (security_invoker = on) restated deliberately: a replace with no WITH clause
-- RESETS reloptions and silently strips it (four recorded occurrences in this repo).
CREATE OR REPLACE VIEW public.panini_squeeze_board
WITH (security_invoker = on) AS
SELECT m.* FROM public.mv_panini_squeeze m;
