-- Snapshot migration: public.draw_raffle(bigint, text).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- Draws a winner for a credits-raffle shop item, CREDITS-WEIGHTED: a user with
-- more credits has a proportionally larger chance. Implemented as a cumulative-
-- sum band selection over per-user credit totals ordered by user_id, picking the
-- first band whose running total >= random()*total_credits. A regression in the
-- band math makes the raffle unfair or riggable, and the recorded raffle_draws
-- row is the audit trail (total_entrants / total_credits / winner). Empty raffle
-- → ok:false 'no_entries' (never draws a NULL winner).
--
-- Pinned by supabase/tests/draw_raffle.sql (which overrides random() to make the
-- band selection deterministic and assert each credit band selects its user).

CREATE OR REPLACE FUNCTION public.draw_raffle(p_shop_item_id bigint, p_admin text DEFAULT 'owner'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_total bigint; v_entrants int; v_pick numeric; v_winner uuid; v_draw_id bigint;
BEGIN
  SELECT coalesce(sum(credits),0), count(DISTINCT user_id) INTO v_total, v_entrants
    FROM raffle_entries WHERE shop_item_id = p_shop_item_id;
  IF v_total = 0 THEN RETURN jsonb_build_object('ok',false,'error','no_entries'); END IF;
  v_pick := random() * v_total;
  SELECT user_id INTO v_winner FROM (
    SELECT user_id, sum(credits) OVER (ORDER BY user_id) AS cum
    FROM (SELECT user_id, sum(credits) AS credits FROM raffle_entries
           WHERE shop_item_id = p_shop_item_id GROUP BY user_id) g
  ) c WHERE c.cum >= v_pick ORDER BY c.cum LIMIT 1;
  INSERT INTO raffle_draws(shop_item_id, winner_user_id, total_entrants, total_credits, drawn_by, detail)
    VALUES (p_shop_item_id, v_winner, v_entrants, v_total, p_admin, jsonb_build_object('pick', v_pick))
    RETURNING id INTO v_draw_id;
  RETURN jsonb_build_object('ok',true,'draw_id',v_draw_id,'winner_user_id',v_winner,'entrants',v_entrants,'total_credits',v_total);
END $function$;
