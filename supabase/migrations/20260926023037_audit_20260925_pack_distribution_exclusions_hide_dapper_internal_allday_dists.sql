-- 2026-09-25 (PT) — Dapper's internal All Day pack distributions leave the
-- public packs board and the sitemap; every legitimate pack stays.
--
-- WHY. 33 All Day distributions are Dapper's own plumbing, not products a
-- collector can get: "NFL Pack Hold – Genesis", "Pack Test 2", "Do Not Use",
-- "Series 7 removal", "Jan 29 hold" … They sat in pack_table_rows (the packs
-- board) and the pack sitemap. Trevor, 2026-09-25: "Leave all the packs out
-- there if they're legitimate."
--
-- THE TEST IS EVIDENCE, NOT A TITLE PATTERN. A title rule would also catch
-- "Wideout Wonders Trade In Reward" (5975): no image either, but 553 rips and
-- 13 sales — a real pack, and it stays. An exclusion here requires BOTH:
--   (a) Dapper publishes no art for it (Studio Platform `images` DEFAULT url
--       is "", read 2026-09-25 ~7:40 PM PT), and
--   (b) nobody has opened, bought or sold one: 0 pack_rips, 0 pack_purchases,
--       0 rows in the collection's pack sales history (measured the same hour).
--
-- A SUPPRESSION IS A CLAIM, SO IT IS RE-DERIVED ON EVERY READ. Readers use
-- v_pack_distribution_exclusions_active, which drops an exclusion the moment
-- its dist gains ANY rip, purchase or sale — if Dapper ever releases one of
-- these, it reappears with no one having to remember this table exists.
-- Excluded dists stay reachable by direct URL (/nfl-all-day/pack/dist/<id>);
-- they are only removed from the board listing and the sitemap.
--
-- Revert: DROP VIEW public.v_pack_distribution_exclusions_active;
-- DROP TABLE public.pack_distribution_exclusions; (the readers treat a
-- missing/failed read as "no exclusions" — fail open, every pack shown).

CREATE TABLE IF NOT EXISTS public.pack_distribution_exclusions (
  collection_id uuid NOT NULL REFERENCES public.collections(id),
  dist_id       text NOT NULL,
  reason        text NOT NULL,
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  excluded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, dist_id)
);
ALTER TABLE public.pack_distribution_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_distribution_exclusions FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.pack_distribution_exclusions IS
  'Pack distributions hidden from the packs board + sitemap because they are Dapper-internal (no published art AND no rip/purchase/sale). Read ONLY through v_pack_distribution_exclusions_active, which re-derives (b) on every read.';

CREATE OR REPLACE VIEW public.v_pack_distribution_exclusions_active
WITH (security_invoker = on) AS
SELECT e.collection_id, e.dist_id, e.reason
FROM public.pack_distribution_exclusions e
WHERE NOT EXISTS (SELECT 1 FROM public.pack_rips r
                   WHERE r.collection_id = e.collection_id AND r.dist_id = e.dist_id)
  AND NOT EXISTS (SELECT 1 FROM public.pack_purchases pp
                   WHERE pp.collection_id = e.collection_id AND pp.pack_dist_id = e.dist_id)
  AND NOT EXISTS (SELECT 1 FROM public.allday_pack_sales_history h
                   WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND h.dist_id = e.dist_id)
  AND NOT EXISTS (SELECT 1 FROM public.topshot_pack_sales_history h
                   WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND h.dist_id = e.dist_id)
  AND NOT EXISTS (SELECT 1 FROM public.golazos_pack_sales_history h
                   WHERE e.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75' AND h.dist_id = e.dist_id);
REVOKE ALL ON public.v_pack_distribution_exclusions_active FROM PUBLIC, anon, authenticated;

WITH d(dist_id) AS (VALUES
  ('5730'), ('5794'), ('5816'), ('5847'), ('5911'), ('5918'), ('5922'), ('5970'), ('5971'),
  ('5977'), ('5978'), ('6040'), ('6103'), ('6132'), ('6228'), ('6229'), ('6250'), ('6251'),
  ('6300'), ('6377'), ('6456'), ('6459'), ('6528'), ('6572'), ('6818'), ('6819'), ('6858'),
  ('7029'), ('7036'), ('7068'), ('7075'), ('7090'), ('7135')
)
INSERT INTO public.pack_distribution_exclusions (collection_id, dist_id, reason, evidence)
SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', d.dist_id, 'dapper_internal_distribution',
       jsonb_build_object('studio_default_image', '', 'rips', 0, 'purchases', 0, 'sales', 0,
                          'title', pd.title, 'checked', '2026-09-25')
FROM d
JOIN public.pack_distributions pd
  ON pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND pd.dist_id = d.dist_id
ON CONFLICT (collection_id, dist_id) DO NOTHING;

-- Post-conditions: all 33 excluded AND still active (zero activity re-derived
-- by the view); the legitimate imageless pack 5975 is NOT excluded; nothing
-- that has an image is excluded.
DO $$
DECLARE v_tbl int; v_active int;
BEGIN
  SELECT count(*) INTO v_tbl FROM public.pack_distribution_exclusions;
  SELECT count(*) INTO v_active FROM public.v_pack_distribution_exclusions_active;
  IF v_tbl <> 33 OR v_active <> 33 THEN
    RAISE EXCEPTION 'expected 33 excluded + active, got % / %', v_tbl, v_active;
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_pack_distribution_exclusions_active WHERE dist_id = '5975') THEN
    RAISE EXCEPTION 'the legitimate Wideout Wonders Trade In Reward (5975) was excluded';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pack_distribution_exclusions e
               JOIN public.pack_distributions pd ON pd.collection_id = e.collection_id AND pd.dist_id = e.dist_id
              WHERE pd.image_url IS NOT NULL) THEN
    RAISE EXCEPTION 'an excluded dist has published art';
  END IF;
END $$;
