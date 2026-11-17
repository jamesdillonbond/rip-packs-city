-- audit_20261102_confirmed_opens_count_chain_mints — 2026-11-02 (Claude Code cloud).
--
-- topshot_confirmed_opens_as_of (20261102201245) is the floor Dapper's live per-tier counts are judged
-- against (lib/pack-dist/observed-as-of.ts): opens up to a payload's stamp whose drop a PRIMARY source
-- confirmed. It counted only Dapper's pack index (pack_nft_identity). That index froze ~10-29 (#218),
-- so every pack of a drop minted after it is `not_found` there and its floor read 0 — measured 11-02
-- ~6:25 PM PT on 8911 (AJ Dybantsa Tip-Off): floor 0, i.e. its Atlas counts were checked against
-- nothing, while the chain names all 1,500 of its packs (pack_nft_mints.dist_id, from the Minted
-- event — 20261102232403).
--
-- Now an open counts when EITHER primary source names the same drop: Dapper's index OR the on-chain
-- Minted event. A pool-vote GUESS still never counts. Measured on every fresh Atlas dist that has any
-- chain mint (2,913): exactly one floor changes — 8911, 0 -> 701 against Atlas's 702 opened (two
-- independent sources agreeing to one pack) — and 0 dists become newly refuted. Estate-wide the two
-- sources disagree on 0 packs (11-02 ~3:30 PM PT), so OR cannot double-count a conflicting pack;
-- EXISTS keeps one count per rip.
--
-- Guarded: aborts if the live body is not the 20261102201245 one (CREATE OR REPLACE is a full-body
-- write). Signature, volatility, search_path and ACL unchanged.
--
-- anon-exec: unchanged (topshot_confirmed_opens_as_of) — CREATE OR REPLACE of an existing fn; ACL preserved (service_role only, 20261102201245).
--
-- REVERT: re-apply the function body from 20261102201245 (identity join only).

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.topshot_confirmed_opens_as_of(text, timestamptz)'::regprocedure;
  IF v_md5 <> '7d19e90e031ef545ce6587e8b53f7384' THEN
    RAISE EXCEPTION 'topshot_confirmed_opens_as_of changed since 20261102201245 (live md5 %) -- re-splice', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.topshot_confirmed_opens_as_of(p_dist_id text, p_at timestamptz)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT count(*)::integer
  FROM public.pack_rips r
  WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND r.dist_id = p_dist_id
    AND r.sealed_at <= p_at
    AND (EXISTS (SELECT 1 FROM public.pack_nft_identity i
                  WHERE i.collection_id = r.collection_id AND i.pack_nft_id = r.pack_nft_id AND i.dist_id = r.dist_id)
      OR EXISTS (SELECT 1 FROM public.pack_nft_mints m
                  WHERE m.collection_id = r.collection_id AND m.pack_nft_id = r.pack_nft_id AND m.dist_id = r.dist_id))
$function$;
