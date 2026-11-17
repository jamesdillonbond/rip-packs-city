-- 2026-10-21 ~12:35 PM PT (Claude Code cloud; Trevor: "Do all that makes sense") — #205: the overview's
-- "Priced from Recent Sales" tile was the HIGH/MEDIUM confidence share under a sales label, and read 0 %
-- on LaLiga Golazos while 84 of its 575 editions sold in the last 30 days (a LOW edition priced from its
-- own sales counted 0). The tile becomes "Sold in Last 30 Days": the share of a collection's editions
-- with at least one MARKET sale in the trailing 30 days — a fact, not a confidence tier.
--
-- Counting it per request costs ~11 s cold / 54 k buffers on Top Shot (measured), so it is precomputed
-- hourly into a one-row-per-collection table the stats route reads (lib/collection-stats/read.ts).
-- Population: collections with rows in `sales` (Panini has none there and is excluded rather than
-- published as 0 %), plus Pinnacle from pinnacle_sales against pinnacle_catalog (the render grain the
-- overview's edition count already uses). Numerator ⊆ denominator by construction (joined to the
-- collection's own editions / catalog).
--
-- Measured before applying (~12:30 PM PT): Golazos 84/575, All Day 2,772/6,190, Pinnacle 1,714/2,836,
-- Candy 108/125, UFC 0/617 (closed market — a true 0), Top Shot computed by the first run.
--
-- anon-exec: intentional — not granted (refresh_collection_sold_30d): REVOKEd from PUBLIC, anon,
-- authenticated below; only service_role (the stats route) and pg_cron (postgres) need it.
--
-- REVERT: SELECT cron.unschedule('rpc-collection-sold-30d'); DROP FUNCTION public.refresh_collection_sold_30d();
--         DROP TABLE public.collection_sold_30d;  (the route treats a missing row as "—")
CREATE TABLE IF NOT EXISTS public.collection_sold_30d (
  collection_id     uuid PRIMARY KEY REFERENCES public.collections(id),
  editions_total    integer,
  editions_sold_30d integer,
  computed_at       timestamptz,
  last_error        text,
  last_error_at     timestamptz
);
ALTER TABLE public.collection_sold_30d ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.collection_sold_30d FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.collection_sold_30d TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_collection_sold_30d()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r        record;
  v_total  integer;
  v_sold   integer;
  v_ok     integer := 0;
  v_failed jsonb   := '[]'::jsonb;
  v_pinn   constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
BEGIN
  -- Collections whose sales live in `sales` (Panini's do not: 0 rows there, so a
  -- generic count would publish a false 0 %), plus Pinnacle from its own tables.
  FOR r IN
    SELECT c.id, c.slug, (c.id = v_pinn) AS is_pinn
      FROM public.collections c
     WHERE c.id = v_pinn
        OR EXISTS (SELECT 1 FROM public.sales s WHERE s.collection_id = c.id)
     ORDER BY c.slug
  LOOP
    BEGIN
      IF r.is_pinn THEN
        SELECT count(*) INTO v_total FROM public.pinnacle_catalog;
        SELECT count(DISTINCT ps.render_id) INTO v_sold
          FROM public.pinnacle_sales ps
          JOIN public.pinnacle_catalog pc ON pc.render_id = ps.render_id
         WHERE ps.sold_at > now() - interval '30 days'
           AND ps.sale_price_usd > 0;
      ELSE
        SELECT count(*) INTO v_total FROM public.editions e WHERE e.collection_id = r.id;
        -- Market sales only (sales_market excludes registered buyback wallets), and
        -- only editions of THIS collection, so the numerator is a subset of the
        -- denominator by construction.
        SELECT count(DISTINCT sm.edition_id) INTO v_sold
          FROM public.sales_market sm
          JOIN public.editions e ON e.id = sm.edition_id AND e.collection_id = r.id
         WHERE sm.collection_id = r.id
           AND sm.sold_at > now() - interval '30 days'
           AND sm.price_usd > 0;
      END IF;

      INSERT INTO public.collection_sold_30d (collection_id, editions_total, editions_sold_30d, computed_at, last_error, last_error_at)
      VALUES (r.id, v_total, v_sold, now(), NULL, NULL)
      ON CONFLICT (collection_id) DO UPDATE
        SET editions_total = EXCLUDED.editions_total,
            editions_sold_30d = EXCLUDED.editions_sold_30d,
            computed_at = EXCLUDED.computed_at,
            last_error = NULL,
            last_error_at = NULL;
      v_ok := v_ok + 1;
    EXCEPTION
      -- A statement timeout (57014) is NOT caught by WHEN OTHERS; name it, so one slow
      -- collection is recorded and the rest still refresh (R118).
      WHEN query_canceled OR OTHERS THEN
        -- The old figures and computed_at are kept, so the reader's age gate sees them
        -- go stale; the error is recorded beside them.
        INSERT INTO public.collection_sold_30d (collection_id, editions_total, editions_sold_30d, computed_at, last_error, last_error_at)
        VALUES (r.id, NULL, NULL, NULL, SQLERRM, now())
        ON CONFLICT (collection_id) DO UPDATE
          SET last_error = EXCLUDED.last_error, last_error_at = EXCLUDED.last_error_at;
        v_failed := v_failed || jsonb_build_object('slug', r.slug, 'error', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', v_ok, 'failed', v_failed);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_collection_sold_30d() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_collection_sold_30d() TO service_role;

SELECT cron.schedule('rpc-collection-sold-30d', '26 * * * *', 'SELECT public.refresh_collection_sold_30d()');
