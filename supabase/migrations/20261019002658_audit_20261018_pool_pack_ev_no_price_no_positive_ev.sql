-- audit_20261018_pool_pack_ev_no_price_no_positive_ev
--
-- WHY: compute_pack_ev_from_pool and compute_pack_ev_from_pool_tier_weighted answer
-- 'is_positive_ev', v_pack_ev > 0 — with pack_ev = gross_ev - COALESCE(p_pack_price, 0), an
-- unknown (0/NULL) price makes any pool with value "+EV". Their sibling
-- compute_pack_ev_per_edition_weighted (the live All Day / Golazos writer) already reads
-- COALESCE(p_pack_price, 0) > 0 AND v_pack_ev > 0, and the edge writers stopped writing
-- zero-price +EV rows at ~9:37 AM PT 10-18 (c6572c45c). The live path still exposed:
-- mcp_compute_pack_ev (concierge) passes pack_distributions.metadata->>'retail_price_usd',
-- which is '0' on 1,337 dists (1,278 Top Shot, 59 Pinnacle; read 10-18 ~5:25 PM PT), straight
-- into compute_pack_ev_from_pool, so the concierge could call an unpriced pack +EV.
--
-- HOW: a one-token splice of the live body, guarded on md5(prosrc) and on the anchor occurring
-- exactly once (verified 10-18: 1 hit each), then CREATE OR REPLACE via the re-read definition.
-- Same signature, so ACLs, SECURITY INVOKER and search_path are kept.
-- anon-exec: intentional — unchanged by this migration; CREATE OR REPLACE with the same signature keeps the existing grants (compute_pack_ev_from_pool)
-- anon-exec: intentional — unchanged by this migration; CREATE OR REPLACE with the same signature keeps the existing grants (compute_pack_ev_from_pool_tier_weighted)
--
-- POST-APPLY (10-18 ~5:28 PM PT): md5(prosrc) compute_pack_ev_from_pool f4e5dc7186c5dde172b5487521540554,
-- compute_pack_ev_from_pool_tier_weighted 658ebe3cbf1245bb969e55158b670d48; ACLs unchanged;
-- check_secdef_anon_exec_drift() = 0. Probe: dists 5787/2298/6921 at price 0 -> is_positive_ev false
-- (gross 0.24/0.28/5.08); positive control at $0.01 -> true.
-- REVERT: the same DO block with v_old/v_new swapped, guarded on the two post-apply md5s above.
DO $$
DECLARE
  r record;
  v_def text;
  v_n int := 0;
  v_old constant text := '''is_positive_ev'', v_pack_ev > 0,';
  v_new constant text := '''is_positive_ev'', COALESCE(p_pack_price, 0) > 0 AND v_pack_ev > 0,';
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, md5(p.prosrc) AS m, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('compute_pack_ev_from_pool', 'compute_pack_ev_from_pool_tier_weighted')
  LOOP
    IF NOT ((r.proname = 'compute_pack_ev_from_pool' AND r.m = 'e8139f62b7fb42d8fabe18ce768042bd')
         OR (r.proname = 'compute_pack_ev_from_pool_tier_weighted' AND r.m = 'a67e24c4a6a8968f85fadffa1d49021c')) THEN
      RAISE EXCEPTION '% body drifted (md5 %): re-read before splicing', r.proname, r.m;
    END IF;
    IF (length(r.prosrc) - length(replace(r.prosrc, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION '% anchor does not occur exactly once', r.proname;
    END IF;
    v_def := pg_get_functiondef(r.oid);
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION '% anchor not exactly once in functiondef', r.proname;
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected 2 functions, spliced %', v_n; END IF;
END
$$;
