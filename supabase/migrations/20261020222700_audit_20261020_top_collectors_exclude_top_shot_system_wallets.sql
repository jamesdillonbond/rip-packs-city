-- audit_20261020_top_collectors_exclude_top_shot_system_wallets
-- anon-exec: unchanged (get_edition_top_owners) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege('anon', …, 'EXECUTE') = false on 2026-10-20.
--
-- The player-page "Top Collectors" panel (topshot_rookie_collector_leaderboard_mv, via
-- get_topshot_rookie_collectors) and the edition-page "Top Owners" panel (get_edition_top_owners)
-- ranked TOP SHOT'S OWN ACCOUNTS as collectors. Measured 2026-10-20 3:20 PM PT, before this change:
--   * 0xb6f2481eba4df97b — Dapper's pack-distribution (PDS) account, 22,718 walk-confirmed Top Shot
--     Moments, zero lifetime buys or sells — was rank 1 on 39 of the 61 2025 rookies' boards;
--   * system accounts appeared on all 61 boards (6,329 Moments, ranks 1–159);
--   * the edition panel counted the same accounts in "N collectors hold X of its M moments".
-- Moments sitting in a pack-distribution or buyback account are inventory, not a collector's holding,
-- and the 2026-27 season-long leaderboards (Blue Chip /3, Rookie Yearbook /26, Squad Goals /10)
-- make "who leads this player's board" a question collectors now act on.
--
-- Exclusion resolves through the EXISTING registry public.flowty_excluded_addresses (its labels name
-- the PDS, the buyback and the merchant-routing accounts and say "excluded … to avoid polluting user
-- collector statistics"), never a literal list here — CLAUDE.md: a hardcoded allowlist beside a
-- registry goes stale silently. A member address in the registry is not a holding; the canonical
-- grouping is unchanged.
--
-- MV: RENAME-aside + CREATE in one transaction (the cloud session's MCP gate cancels a DROP; same
-- pattern as 20261015200615), same columns, same two indexes (the unique one keeps pg_cron job 40's
-- REFRESH … CONCURRENTLY valid), same grants. The renamed copy has no reader and no refresh; it is
-- dropped by a one-off pg_cron job (ledger entry names it). Body = 20261015200615 plus the NOT EXISTS
-- predicate. get_edition_top_owners body = 20261015200615 (live prosrc md5
-- 74c98d042f58df84da6d1a5a1740182a, matched before replacing) plus the same predicate.
--
-- REVERT: re-run the two definitions in 20261015200615 (MV: rename this one aside, then its CREATE,
--   both indexes, REVOKE/GRANT; get_edition_top_owners: its CREATE OR REPLACE).

ALTER MATERIALIZED VIEW public.topshot_rookie_collector_leaderboard_mv RENAME TO topshot_rookie_collector_leaderboard_mv_pre20261020;
ALTER INDEX public.ix_rclb_pk RENAME TO ix_rclb_pk_pre20261020;
ALTER INDEX public.ix_rclb_rank RENAME TO ix_rclb_rank_pre20261020;
REVOKE ALL ON public.topshot_rookie_collector_leaderboard_mv_pre20261020 FROM PUBLIC, anon, authenticated;

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
            AND NOT EXISTS (SELECT 1 FROM flowty_excluded_addresses x WHERE x.address = o.owner_address)
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

COMMENT ON MATERIALIZED VIEW public.topshot_rookie_collector_leaderboard_mv IS
  'Player-page Top Collectors for the 2025 Top Shot rookie class: walk-confirmed holdings grouped by resolve_canonical_owner, ranked by estimated value (latest FMV). Excludes every address in flowty_excluded_addresses (Top Shot pack-distribution / buyback / routing accounts) — inventory, not a collector. audit_20261020.';

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
      -- 2026-10-20: Top Shot's own accounts (pack distribution, buyback, routing) hold inventory, not a collection
      AND NOT EXISTS (SELECT 1 FROM public.flowty_excluded_addresses x WHERE x.address = topshot_ownership.owner_address)
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
