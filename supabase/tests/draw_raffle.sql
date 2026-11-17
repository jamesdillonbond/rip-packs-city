-- DB invariant: public.draw_raffle(bigint, text) → jsonb — the credits-weighted
-- raffle winner draw (cumulative-sum band selection over per-user credit totals).
-- The band math itself uses random() so the exact winner isn't deterministic, but
-- the load-bearing SAFETY invariants are, and this pins them: an empty raffle
-- returns ok:false 'no_entries' and draws NO winner/row; a real draw ALWAYS
-- selects one of the actual entrants (never NULL, never a non-entrant — a band
-- off-by-one that selected nobody would corrupt the raffle silently); the
-- recorded raffle_draws audit row carries the correct total_entrants/total_credits;
-- and a single-entrant raffle is fully deterministic (that entrant always wins).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802183000_audit_20260802_snapshot_draw_raffle.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE raffle_entries (
  shop_item_id bigint,
  user_id      uuid,
  credits      integer
);

CREATE TABLE raffle_draws (
  id             bigserial PRIMARY KEY,
  shop_item_id   bigint,
  winner_user_id uuid,
  total_entrants integer,
  total_credits  bigint,
  drawn_by       text,
  detail         jsonb
);

-- >>> BEGIN verbatim draw_raffle (keep byte-identical to the migration) >>>
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
-- <<< END verbatim draw_raffle <<<

-- Empty raffle (shop item with no entries) → ok:false, no winner, no draw row.
SELECT _assert_eq(draw_raffle(999)->>'ok', 'false', 'no entries → ok:false');
SELECT _assert_eq(draw_raffle(999)->>'error', 'no_entries', 'no entries → error no_entries');
SELECT _assert_eq((SELECT count(*)::text FROM raffle_draws), '0', 'empty raffle drew nothing');

-- Single entrant (credits summed across two entries) → deterministically wins,
-- and the payload + audit row carry the right totals.
INSERT INTO raffle_entries (shop_item_id, user_id, credits) VALUES
  (1, '00000000-0000-0000-0000-00000000000a', 20),
  (1, '00000000-0000-0000-0000-00000000000a', 30);
SELECT _assert_eq(draw_raffle(1)->>'winner_user_id', '00000000-0000-0000-0000-00000000000a', 'single entrant always wins');
SELECT _assert_eq(draw_raffle(1)->>'total_credits', '50', 'total_credits summed across the user''s entries');
SELECT _assert_eq(draw_raffle(1)->>'entrants', '1', 'entrants = 1 distinct user');
SELECT _assert_eq((SELECT DISTINCT total_credits::text FROM raffle_draws WHERE shop_item_id=1), '50', 'audit row records total_credits');
SELECT _assert_eq((SELECT DISTINCT drawn_by FROM raffle_draws WHERE shop_item_id=1), 'owner', 'audit row records drawn_by default');

-- Three entrants: across 40 draws the winner is ALWAYS one of the three (never
-- NULL, never a non-entrant) and totals are always correct. This is the property
-- that a band off-by-one (selecting nobody / NULL) would break.
INSERT INTO raffle_entries (shop_item_id, user_id, credits) VALUES
  (2, '00000000-0000-0000-0000-00000000000a', 10),
  (2, '00000000-0000-0000-0000-00000000000b', 30),
  (2, '00000000-0000-0000-0000-00000000000c', 60);
DO $$
DECLARE i int; r jsonb; entrants uuid[] := ARRAY[
  '00000000-0000-0000-0000-00000000000a'::uuid,
  '00000000-0000-0000-0000-00000000000b'::uuid,
  '00000000-0000-0000-0000-00000000000c'::uuid];
BEGIN
  FOR i IN 1..40 LOOP
    r := draw_raffle(2);
    PERFORM _assert((r->>'winner_user_id')::uuid = ANY(entrants), 'draw '||i||': winner is a real entrant (never NULL/other)');
    PERFORM _assert_eq(r->>'total_credits', '100', 'draw '||i||': total_credits = 100');
    PERFORM _assert_eq(r->>'entrants', '3', 'draw '||i||': entrants = 3');
  END LOOP;
END $$;
SELECT _assert(( (SELECT bool_and(winner_user_id IS NOT NULL) FROM raffle_draws WHERE shop_item_id=2) ),
  'every recorded draw has a non-NULL winner');

SELECT '✓ draw_raffle invariants pass' AS result;
ROLLBACK;
