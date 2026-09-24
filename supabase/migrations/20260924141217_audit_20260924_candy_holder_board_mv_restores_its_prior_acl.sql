-- audit_20260924_candy_holder_board_mv_restores_its_prior_acl
--
-- Follow-up to 20260924141150, which re-created mv_candy_holder_board. The new object inherited the
-- schema's DEFAULT PRIVILEGES (anon=rxm, authenticated=rxtm), and that migration's
-- `REVOKE ALL ... FROM PUBLIC` does not remove explicit role grants. check_public_security_invariants()
-- immediately reported (mv_anon_readable, mv_candy_holder_board). This restores the exact ACL the MV
-- had before the rebuild: postgres + service_role full, anon/authenticated MAINTAIN only.
-- ⚠ LESSON: after any DROP/CREATE of a relation, revoke from anon and authenticated BY NAME, then
-- re-grant, and assert the ACL in the same migration.
--
-- REVERT: none needed; this only narrows access back to its previous state.
--
-- anon-exec: not applicable — this migration creates no function.

REVOKE ALL ON public.mv_candy_holder_board FROM anon, authenticated;
GRANT MAINTAIN ON public.mv_candy_holder_board TO anon, authenticated;

DO $assert$
DECLARE v_acl text;
BEGIN
  SELECT relacl::text INTO v_acl FROM pg_class WHERE oid = 'public.mv_candy_holder_board'::regclass;
  IF v_acl LIKE '%anon=r%' OR v_acl LIKE '%authenticated=r%' THEN
    RAISE EXCEPTION 'mv_candy_holder_board is still client-readable: %', v_acl;
  END IF;
END
$assert$;
