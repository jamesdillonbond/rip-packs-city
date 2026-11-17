-- audit_20261015_ownership_readers_count_only_walk_confirmed_holdings
-- anon-exec: unchanged (get_edition_top_owners) — CREATE OR REPLACE of an existing fn, identical signature and return type; ACL preserved (postgres + service_role EXECUTE only), verified 2026-10-15.
--
-- Companion to 20261015200136 (topshot_ownership.walk_missed_at). Every HOLDINGS reader of
-- topshot_ownership now counts only rows no on-chain walk has contradicted
-- (`walk_missed_at IS NULL`). Readers that use the table only as an nft -> edition map
-- (collect_wallet_pack_pulls, refresh_topshot_moment_id_editions, get_ownership_backfill_targets)
-- are deliberately unchanged: a traded-in moment is still that edition.
--
--   1. get_edition_top_owners — edition page "Top owners". Base = live prosrc md5
--      dea55695d3e90f6c8160392fbca3eee6 (= 20260929235800 body). One predicate added.
--   2. refresh_topshot_edition_concentration (squeeze "Top 5 hold") is in its own file,
--      20261015215728 (refresh_topshot_edition_concentration_v2): v1's body carries the R123
--      write-then-retire statement the cloud session's MCP write gate holds, so the fix is a _v2
--      that retires by UPDATE; pg_cron job 682 calls it.
--   3. topshot_rookie_collector_leaderboard_mv — player-page "Top collectors". RENAME-aside + CREATE,
--      body = 20260929235800 plus the predicate; same columns, same two indexes, same grants.
--   4. topshot_set_completers_mv — RENAME-aside + CREATE, body = live viewdef plus the predicate; same unique
--      index. Its only reader is the SECDEF get_topshot_set_completers (service role), so the
--      re-created MV grants anon/authenticated nothing (the old ACL gave them MAINTAIN = may REFRESH).
--
-- Measured on apply (old MV renamed aside vs new): the value-ranked top-3 changed for 14 of 61
-- rookies (15 entries dropped; e.g. a Cooper Flagg #1 credited 75 moments holds 52 -> #4). Rookie
-- leaderboard moments_held 83,202 -> 73,081; set completers 245 -> 210. Flagged moments of 4
-- dropped top-3 holders: 16/16 absent from the wallet on chain (Flow REST borrowMoment).
--
-- FOLLOW-UP (operator, DROP is refused for the cloud session):
--   docs/pending-sql/audit_20261015_drop_pre20261015_ownership_mvs.sql
--
-- REVERT: re-apply 20260929235800 (fn 1 + MV 3) and 20260802012321's set-completers MV; or simply
-- `UPDATE topshot_ownership SET walk_missed_at = NULL` to make every predicate here a no-op.

-- Applied with a lock timeout so a busy reader fails the migration fast instead of holding it.
-- (A first attempt hit the 2 min statement_timeout; it passed after ANALYZE topshot_ownership,
-- which the previous migration's 17,512-row flag write had left without stats for the new column.)
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.get_edition_top_owners(p_edition_id uuid, p_limit integer DEFAULT 10)
 RETURNS TABLE(owner_address text, moment_count integer, low_serial integer, total_holders integer, total_moments integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH ext AS (
    SELECT external_id FROM public.editions WHERE id = p_edition_id
  ),
  o AS (
    SELECT owner_address AS member, public.resolve_canonical_owner(owner_address) AS canon, serial_number
    FROM public.topshot_ownership
    WHERE edition_external_id = (SELECT external_id FROM ext)
      AND walk_missed_at IS NULL   -- 2026-10-15: a row the holder's on-chain walk did not find is not a holding
  ),
  agg AS (
    SELECT canon, count(*)::int AS moments, min(serial_number)::int AS low_serial
    FROM o GROUP BY canon
  ),
  -- The address a group is SHOWN as: the member holding the most of its moments
  -- (the grouping key is the Flow Wallet parent, which has no username and does
  -- not hold the moments).
  disp AS (
    SELECT DISTINCT ON (canon) canon, member
    FROM (SELECT canon, member, count(*) AS n FROM o GROUP BY canon, member) m
    ORDER BY canon, n DESC, member
  ),
  tot AS (
    SELECT count(DISTINCT canon)::int AS holders, count(*)::int AS moments FROM o
  )
  SELECT d.member AS owner_address, a.moments AS moment_count, a.low_serial,
         t.holders AS total_holders, t.moments AS total_moments
  FROM agg a JOIN disp d ON d.canon = a.canon CROSS JOIN tot t
  ORDER BY a.moments DESC, a.low_serial ASC NULLS LAST
  LIMIT greatest(1, least(p_limit, 25));
$function$;

-- The cloud session's write gate refuses a drop, so the old MV is RENAMED aside (with its indexes)
-- and the new one takes the name every reader and the refresh cron use. The renamed copy is inert
-- (no reader, no refresh); dropping it is a follow-up for an operator session.
ALTER MATERIALIZED VIEW public.topshot_rookie_collector_leaderboard_mv RENAME TO topshot_rookie_collector_leaderboard_mv_pre20261015;
ALTER INDEX public.ix_rclb_pk RENAME TO ix_rclb_pk_pre20261015;
ALTER INDEX public.ix_rclb_rank RENAME TO ix_rclb_rank_pre20261015;
REVOKE ALL ON public.topshot_rookie_collector_leaderboard_mv_pre20261015 FROM PUBLIC, anon, authenticated;

CREATE MATERIALIZED VIEW public.topshot_rookie_collector_leaderboard_mv AS
 WITH rookie_eds AS (
         SELECT e.external_id,
            e.player_name,
            e.id AS edition_id
           FROM (editions e
             JOIN topshot_2025_rookie_players rp ON ((rp.player_name = e.player_name)))
          WHERE ((e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid) AND ((e.external_id)::text ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'::text))
        ), ed_val AS (
         SELECT re.external_id,
            re.player_name,
            COALESCE(( SELECT fs.fmv_usd
                   FROM fmv_snapshots fs
                  WHERE (fs.edition_id = re.edition_id)
                  ORDER BY fs.computed_at DESC
                 LIMIT 1), (0)::numeric) AS unit_fmv
           FROM rookie_eds re
        ), resolved AS (
         SELECT ev.player_name,
            o.owner_address AS member,
            resolve_canonical_owner(o.owner_address) AS canon,
            ev.unit_fmv
           FROM (topshot_ownership o
             JOIN ed_val ev ON (((ev.external_id)::text = o.edition_external_id)))
          WHERE (o.walk_missed_at IS NULL)
        ), disp AS (
         SELECT DISTINCT ON (m.player_name, m.canon) m.player_name,
            m.canon,
            m.member
           FROM ( SELECT resolved.player_name,
                    resolved.canon,
                    resolved.member,
                    count(*) AS n
                   FROM resolved
                  GROUP BY resolved.player_name, resolved.canon, resolved.member) m
          ORDER BY m.player_name, m.canon, m.n DESC, m.member
        ), h AS (
         SELECT resolved.player_name,
            resolved.canon,
            count(*) AS moments_held,
            round(sum(resolved.unit_fmv), 2) AS est_value_usd
           FROM resolved
          GROUP BY resolved.player_name, resolved.canon
        )
 SELECT h.player_name,
    d.member AS wallet_address,
    h.moments_held,
    h.est_value_usd,
    rank() OVER (PARTITION BY h.player_name ORDER BY h.est_value_usd DESC, h.moments_held DESC) AS rnk
   FROM (h
     JOIN disp d ON (((d.player_name = h.player_name) AND (d.canon = h.canon))));

CREATE UNIQUE INDEX ix_rclb_pk ON public.topshot_rookie_collector_leaderboard_mv USING btree (player_name, wallet_address);
CREATE INDEX ix_rclb_rank ON public.topshot_rookie_collector_leaderboard_mv USING btree (player_name, rnk);

REVOKE ALL ON public.topshot_rookie_collector_leaderboard_mv FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.topshot_rookie_collector_leaderboard_mv TO service_role;

ALTER MATERIALIZED VIEW public.topshot_set_completers_mv RENAME TO topshot_set_completers_mv_pre20261015;
ALTER INDEX public.ix_tscm_pk RENAME TO ix_tscm_pk_pre20261015;
REVOKE ALL ON public.topshot_set_completers_mv_pre20261015 FROM PUBLIC, anon, authenticated;

CREATE MATERIALIZED VIEW public.topshot_set_completers_mv AS
 WITH base_eds AS (
         SELECT e.set_id,
            e.set_name,
            e.set_id_onchain,
            e.external_id
           FROM editions e
          WHERE ((e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid) AND ((e.external_id)::text ~ '^[0-9]+:[0-9]+$'::text) AND (e.set_id_onchain = ANY (ARRAY[219, 220, 223, 233, 238, 241, 243, 246, 260, 261])))
        ), set_totals AS (
         SELECT base_eds.set_id,
            base_eds.set_name,
            base_eds.set_id_onchain,
            count(DISTINCT base_eds.external_id) AS total_plays
           FROM base_eds
          GROUP BY base_eds.set_id, base_eds.set_name, base_eds.set_id_onchain
        ), resolved AS (
         SELECT be.set_id,
            resolve_canonical_owner(o.owner_address) AS owner_address,
            be.external_id
           FROM (topshot_ownership o
             JOIN base_eds be ON (((be.external_id)::text = o.edition_external_id)))
          WHERE (o.walk_missed_at IS NULL)
        ), owner_set AS (
         SELECT resolved.set_id,
            resolved.owner_address,
            count(DISTINCT resolved.external_id) AS owned_plays
           FROM resolved
          GROUP BY resolved.set_id, resolved.owner_address
        )
 SELECT st.set_id,
    st.set_name,
    st.set_id_onchain,
    st.total_plays,
    count(*) FILTER (WHERE (os.owned_plays >= st.total_plays)) AS completers,
    count(os.owner_address) AS holders_with_any
   FROM (set_totals st
     LEFT JOIN owner_set os ON ((os.set_id = st.set_id)))
  GROUP BY st.set_id, st.set_name, st.set_id_onchain, st.total_plays;

CREATE UNIQUE INDEX ix_tscm_pk ON public.topshot_set_completers_mv USING btree (set_id);

REVOKE ALL ON public.topshot_set_completers_mv FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.topshot_set_completers_mv TO service_role;
