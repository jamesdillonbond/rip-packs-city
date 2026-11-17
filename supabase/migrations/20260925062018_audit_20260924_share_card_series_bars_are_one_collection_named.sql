-- 2026-09-24 (PT) — the public share card's "Series Breakdown" bucketed every
-- collection's raw on-chain series number into one row of bars: "S0 530 · S1
-- 603 · … · S9 132 · SUnknown 1728" on the founder's wallet, where S0 is Top
-- Shot's Series 1, S1 mixes Top Shot Series 2 with All Day / Golazos Series 1,
-- S9 is not a Top Shot series at all, and 1,728 Pinnacle/UFC moments have no
-- series. A count per label that names nothing a collector recognises.
--
-- Change (guarded splice on the LIVE body of get_wallet_collection_snapshot,
-- prosrc md5 c3fb34b3b22c7408d1ce87e06c8a8849 at the time of writing):
--   * `series` now buckets the wallet's LARGEST collection only, labelled via
--     series_display_label(collection_id, series_number) ("Series 2025-26",
--     "Summer 2021"), so the bars are one collection's series named the way
--     every other page names them. The per-collection grid above the bars
--     already carries the cross-collection split.
--   * new keys: 'seriesBars' — an ARRAY ordered by series_number (a jsonb
--     object cannot carry order, and "Series 2023-24" does not sort after
--     "Series 4" lexically), each {label, count, series_number}; and
--     'seriesCollection' {slug, name} naming the collection the bars are of.
--   * 'seriesBreakdown' keeps its {label: count} shape for the older card, now
--     over the same labels (null series → 'SUnknown', which the view names).
-- Everything else in the body is byte-identical. ACL unchanged (postgres +
-- service_role EXECUTE).
-- anon-exec: intentional — SNAPSHOT SPLICE of get_wallet_collection_snapshot; its ACL (service_role only, REVOKEd from anon/authenticated/PUBLIC earlier) is untouched by CREATE OR REPLACE.
-- Revert: re-apply the previous defining migration
-- (grep -l get_wallet_collection_snapshot supabase/migrations/ | sort | tail -2 | head -1).
DO $$
DECLARE
  v_def text;
  v_a1  text := $a$  series AS (
    SELECT jsonb_object_agg(label, cnt) AS obj FROM (
      SELECT 'S' || COALESCE(series_number::text, 'Unknown') AS label,
             count(*) AS cnt
      FROM w GROUP BY 1
    ) s
  ),$a$;
  v_n1  text := $a$  -- 2026-09-24: the bars are the wallet's LARGEST collection's series, named
  -- the way every other page names them (series_display_label). Mixing every
  -- collection's raw series number into one row named nothing ("S0", "S9").
  series_coll AS (
    SELECT w.collection_id, c.slug, c.name
    FROM w JOIN collections c ON c.id = w.collection_id
    GROUP BY w.collection_id, c.slug, c.name
    ORDER BY count(*) DESC, c.slug
    LIMIT 1
  ),
  series_rows AS (
    SELECT w.series_number,
           COALESCE(public.series_display_label(w.collection_id, w.series_number::int), 'SUnknown') AS label,
           count(*)::int AS cnt
    FROM w
    WHERE w.collection_id = (SELECT collection_id FROM series_coll)
    GROUP BY w.collection_id, w.series_number
  ),
  series AS (
    SELECT jsonb_object_agg(label, cnt) AS obj FROM series_rows
  ),
  series_bars AS (
    SELECT jsonb_agg(jsonb_build_object('label', label, 'count', cnt, 'series_number', series_number)
                     ORDER BY series_number NULLS LAST) AS arr
    FROM series_rows
  ),$a$;
  v_a2  text := $a$    'seriesBreakdown', COALESCE((SELECT obj FROM series), '{}'::jsonb),$a$;
  v_n2  text := $a$    'seriesBreakdown', COALESCE((SELECT obj FROM series), '{}'::jsonb),
    'seriesBars', COALESCE((SELECT arr FROM series_bars), '[]'::jsonb),
    'seriesCollection', (SELECT jsonb_build_object('slug', slug, 'name', name) FROM series_coll),$a$;
  v_c int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_wallet_collection_snapshot';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_wallet_collection_snapshot not found'; END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a1, ''))) / length(v_a1);
  IF v_c <> 1 THEN RAISE EXCEPTION 'series CTE anchor found % times', v_c; END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a2, ''))) / length(v_a2);
  IF v_c <> 1 THEN RAISE EXCEPTION 'seriesBreakdown key anchor found % times', v_c; END IF;
  EXECUTE replace(replace(v_def, v_a1, v_n1), v_a2, v_n2);
END $$;

-- Post-conditions: the keys exist, the bars carry display labels, and the
-- ordering follows series_number.
DO $$
DECLARE v jsonb; v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'get_wallet_collection_snapshot';
  IF position('seriesBars' IN v_src) = 0 OR position('series_display_label' IN v_src) = 0 THEN
    RAISE EXCEPTION 'splice did not land';
  END IF;
  v := public.get_wallet_collection_snapshot('0xbd94cade097e50ac');
  IF NOT (v ? 'seriesBars') OR NOT (v ? 'seriesCollection') THEN
    RAISE EXCEPTION 'snapshot lacks the new keys';
  END IF;
  IF jsonb_array_length(v->'seriesBars') > 0 AND (v->'seriesBars'->0->>'label') ~ '^S[0-9]' THEN
    RAISE EXCEPTION 'bars still carry raw S<n> labels: %', v->'seriesBars'->0;
  END IF;
END $$;
