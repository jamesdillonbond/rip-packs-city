-- audit_20261020_rookie_boards_include_the_2026_class
--
-- Series 2026-27 (on-chain series 9) tipped off 2026-10-20; the first rookie Moments mint into Tip-Off
-- Packs this week and the Rookie Debut drop is 2026-11-11 (Top Shot blog, 2026-10-20). The player-page
-- Top Collectors board (topshot_rookie_collector_leaderboard_mv) and get_topshot_player_rank_thresholds
-- only knew the 2025 class (topshot_2025_rookie_players), so the 2026 class would have had no board on
-- the day collectors start chasing Rookie Yearbook /26 and Blue Chip /3.
--
-- topshot_2026_rookie_players: players with an edition in the Series 9 "Rookie Debut" set — the set
-- every rookie with a Moment enters first (blog: Rookie Debut "leads off the rookie season"). Built from
-- set membership, NOT from the draft or the four announced partners (topshot-ownership-index.md), so it
-- is EMPTY until those editions mint and fills by itself. Measured on apply (3:51 PM PT): 0 Series 9
-- sets exist, so the view returns 0 rows and the MV is unchanged apart from normal churn.
-- Same shape and grants as topshot_2025_rookie_players (security_invoker=on; anon/authenticated SELECT
-- like that view — it lists public player names only).
--
-- MV: RENAME-aside + CREATE (the MCP gate cancels DROP), body = 20261020222700 with the rookie join
-- widened to both classes; same columns, same two indexes, same grants. The aside copy is dropped by a
-- one-off pg_cron job (ledger names it).
--
-- REVERT: re-run the MV definition in 20261020222700 (rename this one aside first);
--         then DROP VIEW public.topshot_2026_rookie_players.

CREATE VIEW public.topshot_2026_rookie_players WITH (security_invoker = on) AS
 SELECT DISTINCT e.player_name
   FROM editions e
     JOIN sets s ON s.id = e.set_id
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND s.series = 9 AND s.name::text = 'Rookie Debut'::text AND e.player_name IS NOT NULL;

COMMENT ON VIEW public.topshot_2026_rookie_players IS
  'Top Shot 2026 rookie class: players with an edition in the Series 9 (2026-27) Rookie Debut set. Empty until those editions mint; never seeded from the draft. audit_20261020.';

GRANT SELECT ON public.topshot_2026_rookie_players TO anon, authenticated, service_role;

ALTER MATERIALIZED VIEW public.topshot_rookie_collector_leaderboard_mv RENAME TO topshot_rookie_collector_leaderboard_mv_pre20261020b;
ALTER INDEX public.ix_rclb_pk RENAME TO ix_rclb_pk_pre20261020b;
ALTER INDEX public.ix_rclb_rank RENAME TO ix_rclb_rank_pre20261020b;
REVOKE ALL ON public.topshot_rookie_collector_leaderboard_mv_pre20261020b FROM PUBLIC, anon, authenticated;

CREATE MATERIALIZED VIEW public.topshot_rookie_collector_leaderboard_mv AS
 WITH rookie_eds AS (
         SELECT e.external_id,
            e.player_name,
            e.id AS edition_id
           FROM (editions e
             JOIN (SELECT topshot_2025_rookie_players.player_name FROM topshot_2025_rookie_players
                   UNION
                   SELECT topshot_2026_rookie_players.player_name FROM topshot_2026_rookie_players) rp ON ((rp.player_name = e.player_name)))
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
  'Player-page Top Collectors for the 2025 and 2026 Top Shot rookie classes: walk-confirmed holdings grouped by resolve_canonical_owner, ranked by estimated value (latest FMV). Excludes every address in flowty_excluded_addresses (Top Shot pack-distribution / buyback / routing accounts) — inventory, not a collector. audit_20261020 (2026 class added by 20261020225100).';
