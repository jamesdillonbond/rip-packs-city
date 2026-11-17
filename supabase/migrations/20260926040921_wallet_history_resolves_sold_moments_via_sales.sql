-- 2026-09-25 (PT) — the wallet transaction history names moments the wallet
-- no longer holds, and team moments, instead of printing "Moment".
--
-- WHY. get_wallet_transaction_history resolves a moment row two ways only:
-- wallet_moments_cache (moments the wallet STILL holds) and editions via
-- sales.edition_id (moment_sell rows). A moment_buy whose moment was later
-- sold is in neither, so it rendered as a bare "Moment". Trevor's wallet: the
-- two Sidy Cissoko Rookie Debut buys (nft 46118449 / 46119234) did. And a team
-- moment's edition has player_name NULL (team_name "Atlanta Hawks", set "The
-- Champion's Path"), so its sell rendered as "Moment #323" although the edition
-- resolved.
--
-- WHAT. Three guarded splices (each anchor must match exactly once or the
-- migration RAISEs):
--   1. a LATERAL on sales by (collection_id, nft_id), newest sale, that runs
--      ONLY for a row with an nft_id, no edition_id and no wmc match — it
--      supplies edition_id + serial. idx_sales_nft_id per partition, ~22
--      buffers per unresolved row, page-bounded (<= 200 rows).
--   2. r_player falls back to editions.team_name (a team moment has no player).
--   3. r_serial falls back to that sale's serial.
-- A moment with no wmc row and no sale anywhere (e.g. 2021 buys the indexer
-- never saw) stays "Moment" — unknown, not guessed.
-- Header preserved from pg_proc (STABLE, SECURITY DEFINER, search_path=public,
-- statement_timeout=20s); ACL unchanged.
--
-- Revert: apply the three replacements in reverse (each v_rep back to v_old).

-- anon-exec: unchanged (get_wallet_transaction_history) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-25).
DO $$
DECLARE
  v_src text;
  v_new text;
  v_n   int;
  v_i   int;
  v_before jsonb := '[]'::jsonb;
  v_after  jsonb := '[]'::jsonb;
  v_total_before int; v_total_after int;
  v_changed int; v_bad int;
  v_olds text[] := ARRAY[
    E'    LEFT JOIN public.editions ed ON ed.id = pg.edition_id\n',
    E'      COALESCE(w.player_name, w.character_name, ed.player_name) AS r_player,\n',
    E'      COALESCE(pg.serial_number, w.serial_number) AS r_serial,\n'
  ];
  v_reps text[] := ARRAY[
    E'    -- 2026-09-25: a moment the wallet no longer holds (no wmc row) and\n'
    || E'    -- no edition on the event resolves through its newest sale.\n'
    || E'    LEFT JOIN LATERAL (\n'
    || E'      SELECT s2.edition_id, s2.serial_number\n'
    || E'      FROM public.sales s2\n'
    || E'      WHERE pg.nft_id IS NOT NULL AND pg.edition_id IS NULL AND w.moment_id IS NULL\n'
    || E'        AND s2.collection_id = pg.collection_id AND s2.nft_id = pg.nft_id\n'
    || E'      ORDER BY s2.sold_at DESC\n'
    || E'      LIMIT 1\n'
    || E'    ) sx ON true\n'
    || E'    LEFT JOIN public.editions ed ON ed.id = COALESCE(pg.edition_id, sx.edition_id)\n',
    E'      COALESCE(w.player_name, w.character_name, ed.player_name, ed.team_name) AS r_player,\n',
    E'      COALESCE(pg.serial_number, w.serial_number, sx.serial_number) AS r_serial,\n'
  ];
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_wallet_transaction_history'
     AND pg_get_function_identity_arguments(p.oid) = 'p_wallet text, p_limit integer, p_offset integer, p_kind text';
  IF v_src IS NULL THEN RAISE EXCEPTION 'get_wallet_transaction_history not found'; END IF;
  v_new := v_src;
  FOR v_i IN 1..3 LOOP
    v_n := (length(v_new) - length(replace(v_new, v_olds[v_i], ''))) / length(v_olds[v_i]);
    IF v_n <> 1 THEN RAISE EXCEPTION 'anchor % expected once, found %', v_i, v_n; END IF;
    v_new := replace(v_new, v_olds[v_i], v_reps[v_i]);
  END LOOP;

  -- Before: Trevor's whole history.
  v_total_before := (public.get_wallet_transaction_history('0xbd94cade097e50ac', 1, 0, 'all')->>'total_count')::int;
  FOR v_i IN 0..((v_total_before - 1) / 200) LOOP
    v_before := v_before || (public.get_wallet_transaction_history('0xbd94cade097e50ac', 200, v_i * 200, 'all')->'events');
  END LOOP;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_wallet_transaction_history(p_wallet text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_kind text DEFAULT NULL::text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public'' SET statement_timeout TO ''20s'' AS %L',
    v_new);

  v_total_after := (public.get_wallet_transaction_history('0xbd94cade097e50ac', 1, 0, 'all')->>'total_count')::int;
  IF v_total_after <> v_total_before THEN
    RAISE EXCEPTION 'row count moved: % -> %', v_total_before, v_total_after;
  END IF;
  FOR v_i IN 0..((v_total_after - 1) / 200) LOOP
    v_after := v_after || (public.get_wallet_transaction_history('0xbd94cade097e50ac', 200, v_i * 200, 'all')->'events');
  END LOOP;

  -- No-change control: a row whose title did NOT start with "Moment" is
  -- byte-identical; a changed row was a "Moment" row (pairing by position is
  -- valid — the ORDER BY and row set are unchanged, asserted above).
  SELECT count(*) FILTER (WHERE b.e <> a.e),
         count(*) FILTER (WHERE b.e <> a.e AND b.e->>'title' NOT LIKE 'Moment%')
    INTO v_changed, v_bad
    FROM jsonb_array_elements(v_before) WITH ORDINALITY b(e, i)
    JOIN jsonb_array_elements(v_after)  WITH ORDINALITY a(e, i) USING (i);
  IF v_bad <> 0 THEN RAISE EXCEPTION '% already-resolved rows changed', v_bad; END IF;
  IF v_changed < 3 THEN RAISE EXCEPTION 'expected >= 3 rows resolved, got %', v_changed; END IF;

  -- The three known cases resolve.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_after) e
                  WHERE e->>'nft_id' = '46118449' AND e->>'title' = 'Sidy Cissoko #2628') THEN
    RAISE EXCEPTION 'nft 46118449 did not resolve to Sidy Cissoko #2628';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_after) e
                  WHERE e->>'nft_id' = '46119234' AND e->>'title' = 'Sidy Cissoko #3363') THEN
    RAISE EXCEPTION 'nft 46119234 did not resolve to Sidy Cissoko #3363';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_after) e
                  WHERE e->>'nft_id' = '41810601' AND e->>'title' = 'Atlanta Hawks #323') THEN
    RAISE EXCEPTION 'nft 41810601 did not resolve to Atlanta Hawks #323';
  END IF;
  RAISE NOTICE 'resolved % rows; total %', v_changed, v_total_after;
END $$;

-- Post-condition: the ACL did not move.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.get_wallet_transaction_history(text,integer,integer,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_wallet_transaction_history(text,integer,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_wallet_transaction_history ACL widened';
  END IF;
END $$;
