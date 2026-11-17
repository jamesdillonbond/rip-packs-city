-- 2026-10-21 ~12:43 PM PT (Claude Code cloud; Trevor: "Do all that makes sense") — #205 follow-on:
-- refresh_collection_sold_30d gains a Panini arm, so Panini's overview tile reads a figure instead of a
-- permanent "—". panini_sales is keyed by the edition's external_id (32,808 of 32,817 30-day sales join,
-- measured 12:40 PM PT; 131 ms / 18 k buffers warm). Panini sales reach RPC ~2 days after they happen, so
-- the figure is a floor. Everything else in the body is unchanged from 20261021193802.
--
-- anon-exec: intentional — not granted (refresh_collection_sold_30d): CREATE OR REPLACE keeps the ACL
-- 20261021193802 set (REVOKEd from PUBLIC, anon, authenticated; service_role only).
--
-- REVERT: re-apply the body from 20261021193802_audit_20261021_collection_sold_30d_precompute.sql.
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
  v_pan    constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
BEGIN
  -- Collections whose sales live in `sales`, plus Pinnacle and Panini from their own
  -- tables (neither has rows in `sales`, so the generic count would publish a false 0 %).
  FOR r IN
    SELECT c.id, c.slug, (c.id = v_pinn) AS is_pinn, (c.id = v_pan) AS is_pan
      FROM public.collections c
     WHERE c.id IN (v_pinn, v_pan)
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
      ELSIF r.is_pan THEN
        -- panini_sales keyed by the edition's external_id. Panini sales reach RPC ~2 days
        -- after they happen (median, 2026-10-14), so the newest days are thin — the count
        -- is a floor, never inflated.
        SELECT count(*) INTO v_total FROM public.editions e WHERE e.collection_id = r.id;
        SELECT count(DISTINCT e.id) INTO v_sold
          FROM public.panini_sales ps
          JOIN public.editions e ON e.collection_id = r.id AND e.external_id = ps.edition_external_id
         WHERE ps.sold_at > now() - interval '30 days'
           AND ps.amount_usd > 0;
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
