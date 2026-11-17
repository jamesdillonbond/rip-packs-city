-- 2026-09-25 (PT) — the share card drew TWO "Series 1" bars: Top Shot editions
-- carry Series 1 under on-chain series 0 (475 editions) AND under a stored 1
-- (378 editions, the same sets — "2020 NBA Finals" … "With the Strip" — a
-- residue of the 0↔1 remap history), and series_display_label() names both
-- "Series 1". The bars grouped by series_number, so one series appeared twice.
-- Guarded splice on the LIVE body of get_wallet_collection_snapshot: series_rows
-- groups by LABEL and carries the smallest series_number for ordering.
-- anon-exec: intentional — SPLICE of get_wallet_collection_snapshot (service_role only); ACL untouched by CREATE OR REPLACE.
-- Revert: re-apply 20260925062018.
DO $$
DECLARE
  v_def text;
  v_a1 text := $a$  series_rows AS (
    SELECT w.series_number,
           COALESCE(public.series_display_label(w.collection_id, w.series_number::int), 'SUnknown') AS label,
           count(*)::int AS cnt$a$;
  v_n1 text := $a$  series_rows AS (
    -- 2026-09-25: grouped by LABEL — on-chain 0 and a stored 1 are both Top Shot
    -- "Series 1" and drew two bars.
    SELECT min(w.series_number) AS series_number,
           COALESCE(public.series_display_label(w.collection_id, w.series_number::int), 'SUnknown') AS label,
           count(*)::int AS cnt$a$;
  v_a2 text := $a$    GROUP BY w.collection_id, w.series_number$a$;
  v_n2 text := $a$    GROUP BY w.collection_id, COALESCE(public.series_display_label(w.collection_id, w.series_number::int), 'SUnknown')$a$;
  v_c int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_wallet_collection_snapshot';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_wallet_collection_snapshot not found'; END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a1, ''))) / length(v_a1);
  IF v_c <> 1 THEN RAISE EXCEPTION 'series_rows anchor found % times', v_c; END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a2, ''))) / length(v_a2);
  IF v_c <> 1 THEN RAISE EXCEPTION 'group-by anchor found % times', v_c; END IF;
  EXECUTE replace(replace(v_def, v_a1, v_n1), v_a2, v_n2);
END $$;
DO $$
DECLARE v jsonb; n_labels int; n_bars int;
BEGIN
  v := public.get_wallet_collection_snapshot('0xbd94cade097e50ac');
  SELECT count(*), count(DISTINCT b->>'label') INTO n_bars, n_labels FROM jsonb_array_elements(v->'seriesBars') b;
  IF n_bars <> n_labels THEN RAISE EXCEPTION 'duplicate bar labels remain: % bars, % labels', n_bars, n_labels; END IF;
END $$;
