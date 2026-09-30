-- audit_20260929_linked_owner_groups_display_the_holding_member_not_the_parent
-- anon-exec: unchanged (get_edition_top_owners) — CREATE OR REPLACE of an existing fn, identical signature and RETURNS TABLE; ACL preserved, verified has_function_privilege anon=false, authenticated=false (2026-09-29).
--
-- WHAT BROKE (a user-facing regression the 2026-09-29 linked_accounts backfill
-- made large). Two Top Shot boards group holdings by
-- resolve_canonical_owner(owner_address), which maps a Dapper CHILD to its Flow
-- Wallet PARENT, and then DISPLAY that parent address. The parent is the right
-- grouping key (parent + child combined), but it is the wrong face:
--   - the parent almost never has a Top Shot username: of 1,124 active linked
--     children, 903 are named and only 5 of their canonical parents are;
--   - the wallet link goes to a Flow Wallet page that does not hold the moments.
-- linked_accounts went 217 -> 1,319 rows today, so this went from rare to
-- common. Example, measured before this migration: edition 240:8173's top
-- holder is LincolnCannon (0xad3215681182d9fa, 306 moments); the Top Owners
-- panel showed 0x75c0ecb6ebc02f9c with no name.
--
-- THE CHANGE: grouping is unchanged. The address shown for a group is the
-- MEMBER that holds the most of the group's moments in scope (tie -> lowest
-- address): the account that actually holds them, i.e. almost always the
-- named Dapper child, and a real holder whose wallet page shows the moments.
-- A member resolves to exactly one group, so the displayed address stays
-- unique per group (the MV's unique index still holds).
--   1. get_edition_top_owners: same signature and columns; owner_address is the
--      display member. Base = live prosrc md5 e6287a964f928bf18890f4d6d10afeea
--      (no repo migration defined it before this one).
--   2. topshot_rookie_collector_leaderboard_mv: wallet_address is the display
--      member per (player, group). DROP + CREATE (an MV has no OR REPLACE),
--      same columns, same two indexes, populated here. Its only reader is
--      get_topshot_rookie_collectors (SECURITY DEFINER), which LEFT JOINs
--      wallet_usernames on wallet_address, so names come back with no change
--      to it. The old ACL gave anon/authenticated MAINTAIN (= may REFRESH);
--      the re-created MV grants them nothing, since only the SECDEF reader
--      needs it.
-- topshot_set_completers_mv shows counts only (no addresses) and is unchanged.
--
-- Revert: in get_edition_top_owners drop `member` from `o`, drop the `disp` CTE,
-- and select `a.canon AS owner_address FROM agg a CROSS JOIN tot t`; re-create
-- the MV with `resolve_canonical_owner(o.owner_address) AS wallet_address` in
-- `resolved` and `h` grouped by (player_name, wallet_address) with no `disp`.

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

DROP MATERIALIZED VIEW public.topshot_rookie_collector_leaderboard_mv;

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
