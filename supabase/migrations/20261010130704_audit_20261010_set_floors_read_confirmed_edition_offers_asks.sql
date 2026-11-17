-- audit_20261010_set_floors_read_confirmed_edition_offers_asks
-- anon-exec: unchanged (get_topshot_cheapest_sets_to_complete) — rewrite of an existing fn; ACL preserved, verified anon=false authenticated=false 2026-10-10.
-- anon-exec: unchanged (get_topshot_set_completion_plan) — rewrite of an existing fn; ACL preserved, verified anon=false authenticated=false 2026-10-10.
-- anon-exec: unchanged (get_topshot_set_detail) — rewrite of an existing fn; ACL preserved, verified anon=false authenticated=false 2026-10-10.
-- anon-exec: unchanged (get_topshot_set_progress) — rewrite of an existing fn; ACL preserved, verified anon=false authenticated=false 2026-10-10.
-- anon-exec: unchanged (get_topshot_hot_floors) — rewrite of an existing fn; ACL preserved, verified anon=false authenticated=false 2026-10-10.
--
-- 2026-10-10 (known-issues #184). The Top Shot set surfaces (cost to complete, cheapest
-- missing play, the set detail's buy link) and the hot-floors board take each edition's
-- floor as MIN(edition_offers.low_ask, badge_editions.low_ask) with NO age bound on the
-- edition_offers side. sync_edition_offers_from_atlas re-confirms an ask it re-observes
-- (low_ask_confirmed_at) but only NULLs one on evidence, so an ask nobody has seen for weeks
-- stays put. Measured on Top Shot 10-10: 3,471 edition_offers asks unseen for > 7 days; on
-- 314 editions such an ask is below the fresh badge ask (22 under half of it), so it became
-- the published floor. When both sources are fresh they agree (2,439 of 2,487 equal), so the
-- badge ask is a reliable live read and the unseen lower ask is very likely gone.
--
-- WHAT. In each function's floor CTE the edition_offers arm also requires
-- low_ask_confirmed_at within 7 days (the bound get_team_checklist uses, on the column that
-- means "seen", not updated_at, which moves on unrelated highest_offer changes). Nothing else
-- in any body changes. Applied as a rewrite of each LIVE definition: every function must match
-- the arm exactly once or the migration aborts; a function already carrying the clause is
-- skipped, so a replay is a no-op. CREATE OR REPLACE keeps each function's ACL and settings.
--
-- REVERT: the same DO block with the clause removed, i.e. replace
--   ' AND low_ask_confirmed_at > now() - interval ''7 days'''  with ''  in each definition.

DO $mig$
DECLARE
  r record;
  v_def text;
  v_new text;
  v_clause constant text := ' AND low_ask_confirmed_at > now() - interval ''7 days''';
  v_done int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN ('get_topshot_cheapest_sets_to_complete', 'get_topshot_set_completion_plan',
                         'get_topshot_set_detail', 'get_topshot_set_progress', 'get_topshot_hot_floors')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    IF position('low_ask_confirmed_at' IN v_def) > 0 THEN
      v_done := v_done + 1;
      CONTINUE;
    END IF;
    v_new := regexp_replace(
      v_def,
      '(FROM edition_offers WHERE collection_id = (v_ts|p_collection_id) AND low_ask > 0)',
      '\1' || v_clause,
      'g');
    IF length(v_new) - length(v_def) <> length(v_clause) THEN
      RAISE EXCEPTION '%: expected exactly one edition_offers floor arm, rewrite changed % chars',
        r.proname, length(v_new) - length(v_def);
    END IF;
    EXECUTE v_new;
    v_done := v_done + 1;
  END LOOP;
  IF v_done <> 5 THEN
    RAISE EXCEPTION 'expected 5 functions, handled %', v_done;
  END IF;
END
$mig$;
