-- audit_20260923_candy_treasury_is_the_sealed_pack_custodian
--
-- CAUSE (measured 2026-09-23 ~4:45 PM PT): the Candy MLB "treasury" wallet is chosen as the
-- wallet holding the MOST MOMENTS in wallet_moments_cache (`ORDER BY count(*) DESC LIMIT 1`), in
-- three places: refresh_candy_treasury_wallet() (-> candy_treasury_wallet_cache ->
-- candy_treasury_wallet, read by candy_pack_market / candy_special_serials_board) and an INLINE
-- copy inside BOTH mv_candy_holder_board and mv_candy_scarcity_board.
-- On 08-11 that argmax and the independent signal agreed (BhA2Bfd8…APe2: 2,610 moments vs 1,367;
-- sealed packs 107x). Today they DIVERGE (check_candy_treasury_divergence() -> diverged:true):
--   * wallet_moments_cache: 1BWutmTv…DNix 1,789 moments  vs  BhA2Bfd8…APe2 1,714 moments
--   * candy_packs (sealed-pack custody): BhA2Bfd8…APe2 holds 2,332 of 2,501 packs (93%);
--     1BWutmTv…DNix holds 15.
-- The two moment counts are within 4% of each other, so the argmax FLIPPED at the 3:39 PM PT
-- refresh, and every consumer flipped with it:
--   * the public holder board ranks BhA2 — the pack custodian — as the #1 COLLECTOR (1,714), and
--     drops 1BWut, which it had published as a collector until today;
--   * the scarcity board counts 1BWut's moments as "sealed" and BhA2's as "circulating".
-- Neither wallet has any marketplace activity (0 pack/moment buys, sells, listings, offers), so
-- behaviour cannot discriminate them; custody can. 93% of sealed packs is not a heuristic call.
--
-- FIX: the treasury is the wallet holding the most SEALED PACKS (candy_packs.owner), falling back
-- to the old moment argmax ONLY when candy_packs has no owner at all, so an empty or failed pack
-- table can never turn the exclusion into `<> NULL` (which would empty the holder board). The same
-- expression is used in all three places so they cannot disagree again. The label returns to
-- BhA2Bfd8…APe2 — the wallet every surface used before today's flip — and it is now STABLE: a
-- 2,332 vs 15 lead does not flip on moment-count drift.
-- ⚠ NOT decided here: whether 1BWutmTv…DNix is ALSO a house wallet (no market activity, 15 packs,
-- 1,789 moments). This migration restores the pre-flip board; that question is filed separately.
--
-- The MVs are DROPPED and re-created (a materialized view has no CREATE OR REPLACE) with their
-- bodies unchanged except the `treas` CTE, together with their unique indexes (required by the
-- CONCURRENTLY refresh in pg_cron jobs 248 / 436) and their exact ACLs, and the two thin
-- security_invoker pass-through views on top of them.
--
-- REVERT: re-apply refresh_candy_treasury_wallet() from the body quoted in this file's git
-- history (the moment argmax), re-create both MVs from 20260802145536 / 20260903221326 (same
-- DROP/CREATE shape as below), then SELECT public.refresh_candy_treasury_wallet();
--
-- anon-exec: unchanged (refresh_candy_treasury_wallet) — CREATE OR REPLACE of an existing fn keeps its ACL; verified has_function_privilege anon=false, authenticated=false (proacl postgres,service_role only) on 2026-09-23.

CREATE OR REPLACE FUNCTION public.refresh_candy_treasury_wallet()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '110s'
AS $fn$
DECLARE v_wallet text; v_n bigint;
BEGIN
  -- Sealed-pack custody first: the wallet holding the most unopened packs.
  SELECT owner INTO v_wallet
  FROM public.candy_packs
  WHERE owner IS NOT NULL
  GROUP BY owner ORDER BY count(*) DESC, owner LIMIT 1;

  -- Fallback ONLY when no pack has an owner: the old moment-count argmax.
  IF v_wallet IS NULL THEN
    SELECT wallet_address INTO v_wallet
    FROM public.wallet_moments_cache
    WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
    GROUP BY wallet_address ORDER BY count(*) DESC LIMIT 1;
  END IF;

  IF v_wallet IS NULL THEN RETURN NULL; END IF;

  SELECT count(*) INTO v_n
  FROM public.wallet_moments_cache
  WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
    AND wallet_address = v_wallet;

  DELETE FROM public.candy_treasury_wallet_cache;
  INSERT INTO public.candy_treasury_wallet_cache (wallet_address, serials) VALUES (v_wallet, v_n);
  RETURN v_wallet;
END;
$fn$;

DROP VIEW public.candy_holder_board;
DROP MATERIALIZED VIEW public.mv_candy_holder_board;

CREATE MATERIALIZED VIEW public.mv_candy_holder_board AS
 WITH held AS MATERIALIZED (
         SELECT wallet_moments_cache.wallet_address,
            wallet_moments_cache.edition_key
           FROM wallet_moments_cache
          WHERE (wallet_moments_cache.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
        ), treas AS MATERIALIZED (
         SELECT COALESCE(
                  ( SELECT candy_packs.owner
                      FROM candy_packs
                     WHERE (candy_packs.owner IS NOT NULL)
                     GROUP BY candy_packs.owner
                     ORDER BY (count(*)) DESC, candy_packs.owner
                    LIMIT 1),
                  ( SELECT held_1.wallet_address
                      FROM held held_1
                     GROUP BY held_1.wallet_address
                     ORDER BY (count(*)) DESC
                    LIMIT 1)) AS wallet_address
        ), key_fmv AS MATERIALIZED (
         SELECT (e.external_id)::text AS edition_key,
            c.fmv_usd
           FROM (editions e
             LEFT JOIN ( SELECT DISTINCT ON (fmv_snapshots.edition_id) fmv_snapshots.edition_id,
                    fmv_snapshots.fmv_usd
                   FROM fmv_snapshots
                  WHERE (fmv_snapshots.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
                  ORDER BY fmv_snapshots.edition_id, fmv_snapshots.computed_at DESC) c ON ((c.edition_id = e.id)))
          WHERE (e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
        )
 SELECT h.wallet_address,
    count(*) AS serials,
    count(DISTINCT h.edition_key) AS editions,
    round(sum(k.fmv_usd), 2) AS est_fmv_usd,
    count(*) FILTER (WHERE (k.fmv_usd IS NOT NULL)) AS priced_serials
   FROM (held h
     LEFT JOIN key_fmv k ON ((k.edition_key = h.edition_key)))
  WHERE (h.wallet_address <> ( SELECT treas.wallet_address
           FROM treas))
  GROUP BY h.wallet_address;

CREATE UNIQUE INDEX mv_candy_holder_board_wallet_uidx ON public.mv_candy_holder_board USING btree (wallet_address);
REVOKE ALL ON public.mv_candy_holder_board FROM PUBLIC, anon, authenticated;
GRANT MAINTAIN ON public.mv_candy_holder_board TO anon, authenticated;
GRANT ALL ON public.mv_candy_holder_board TO service_role;

CREATE VIEW public.candy_holder_board WITH (security_invoker = on) AS
 SELECT wallet_address,
    serials,
    editions,
    est_fmv_usd,
    priced_serials
   FROM mv_candy_holder_board;
REVOKE ALL ON public.candy_holder_board FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_holder_board TO service_role;

DROP VIEW public.candy_scarcity_board;
DROP MATERIALIZED VIEW public.mv_candy_scarcity_board;

CREATE MATERIALIZED VIEW public.mv_candy_scarcity_board AS
 WITH wmc AS MATERIALIZED (
         SELECT wallet_moments_cache.edition_key,
            wallet_moments_cache.wallet_address
           FROM wallet_moments_cache
          WHERE (wallet_moments_cache.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
        ), treas AS MATERIALIZED (
         SELECT COALESCE(
                  ( SELECT candy_packs.owner
                      FROM candy_packs
                     WHERE (candy_packs.owner IS NOT NULL)
                     GROUP BY candy_packs.owner
                     ORDER BY (count(*)) DESC, candy_packs.owner
                    LIMIT 1),
                  ( SELECT wmc_1.wallet_address
                      FROM wmc wmc_1
                     GROUP BY wmc_1.wallet_address
                     ORDER BY (count(*)) DESC
                    LIMIT 1)) AS wallet_address
        ), h AS (
         SELECT w.edition_key,
            count(*) FILTER (WHERE (w.wallet_address = ( SELECT treas.wallet_address
                   FROM treas))) AS sealed,
            count(*) FILTER (WHERE (w.wallet_address <> ( SELECT treas.wallet_address
                   FROM treas))) AS circulating,
            count(DISTINCT w.wallet_address) FILTER (WHERE (w.wallet_address <> ( SELECT treas.wallet_address
                   FROM treas))) AS holders
           FROM wmc w
          GROUP BY w.edition_key
        )
 SELECT e.external_id,
    e.player_name,
    e.name AS edition_name,
    (e.tier)::text AS tier,
    (e.tier = 'LEGENDARY'::tier_type) AS is_rainbow,
    e.circulation_count,
    COALESCE(h.sealed, (0)::bigint) AS sealed,
    COALESCE(h.circulating, (0)::bigint) AS circulating,
    round(((100.0 * (COALESCE(h.circulating, (0)::bigint))::numeric) / (NULLIF(e.circulation_count, 0))::numeric), 1) AS circulating_pct,
    COALESCE(h.holders, (0)::bigint) AS holders,
    fc.fmv_usd,
    (fc.confidence)::text AS confidence
   FROM ((editions e
     LEFT JOIN h ON ((h.edition_key = (e.external_id)::text)))
     LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = e.id)))
  WHERE (e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid);

CREATE UNIQUE INDEX mv_candy_scarcity_board_external_id_uidx ON public.mv_candy_scarcity_board USING btree (external_id);
REVOKE ALL ON public.mv_candy_scarcity_board FROM PUBLIC, anon, authenticated;
GRANT MAINTAIN ON public.mv_candy_scarcity_board TO anon, authenticated;
GRANT ALL ON public.mv_candy_scarcity_board TO service_role;

CREATE VIEW public.candy_scarcity_board WITH (security_invoker = on) AS
 SELECT external_id,
    player_name,
    edition_name,
    tier,
    is_rainbow,
    circulation_count,
    sealed,
    circulating,
    circulating_pct,
    holders,
    fmv_usd,
    confidence
   FROM mv_candy_scarcity_board;
REVOKE ALL ON public.candy_scarcity_board FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_scarcity_board TO service_role;

SELECT public.refresh_candy_treasury_wallet();
