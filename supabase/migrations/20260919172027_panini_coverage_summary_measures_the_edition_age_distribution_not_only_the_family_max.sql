-- WHY (measured 2026-09-19 ~10:1x PT, Cowork cloud, Trevor present)
--
-- `/insights/panini-squeeze` has been PUBLIC since 2026-08-01 and its coverage banner discloses
-- freshness as `oldest_family_refresh_h` / `newest_family_refresh_h`. Both are MAX(last_seen_at)
-- aggregates PER SET, and a MAX cannot see the distribution underneath it. Measured live today:
--
--   * `Base Prizms Aguila`  — family_newest_h  0.0  and 211 of its 340 editions (62.1%) last
--     walked 45+ days ago.
--   * `Base Prizms White Sparkle` — family_newest_h 3.3 and 121 of 184 (65.8%) 45+ days stale.
--   * The headline `oldest_family_refresh_h` = 1,528 h reads as "one parallel is 64 days behind",
--     but that row is `Aces Prizms Gold` with discovered_editions = 1 — a single card.
--
-- So the existing pair overstates staleness at the top (one edition) and understates it in the
-- body (a 0-hour family that is 62% two months old). The honest quantity is the per-EDITION age
-- distribution, which nothing published measured:
--
--   p50 276.0 h (11.5 d) · p90 1,383.6 h (57.7 d) · max 1,561.8 h
--   1,265 of 5,071 editions (24.9%) last walked 45+ days ago
--   only 1,671 (32.9%) walked in the last 7 days
--
-- Class: a whole-group statistic used as a proxy for a per-slice property (the R109 lesson,
-- CLAUDE.md). Additive only — the twelve existing columns keep their names, types and order, so
-- every current consumer is untouched; the API route and board banner read the new columns in the
-- same pass.
--
-- NOT a function: no anon-exec marker applies. View ACL is unchanged by CREATE OR REPLACE
-- (postgres + service_role SELECT; anon/authenticated hold MAINTAIN only, never SELECT).
--
-- REVERT (exact): re-run this statement with everything from `-- >>> ADDED` to the final column
-- deleted, i.e. ending the SELECT list at `checklist_players_new_24h`.

create or replace view public.panini_coverage_summary as
 WITH per_edition AS (
         SELECT a.set_name,
            a.coverage_flag,
            a.newest_refresh_h,
            a.pct_of_base_checklist,
            generate_series(1::bigint, a.discovered_editions) AS n
           FROM panini_coverage_audit a
        ), checklist AS (
         SELECT count(DISTINCT panini_editions.player_name) AS players,
            count(DISTINCT panini_editions.player_name) FILTER (WHERE (panini_editions.player_name IN ( SELECT panini_editions_1.player_name
                   FROM panini_editions panini_editions_1
                  GROUP BY panini_editions_1.player_name
                 HAVING min(panini_editions_1.created_at) > (now() - '24:00:00'::interval)))) AS new_24h
           FROM panini_editions
          WHERE panini_editions.set_name ~~ 'Base Prizms%'::text OR panini_editions.set_name ~~ 'Base Choice%'::text
        ), fam AS (
         SELECT max(panini_coverage_audit.pct_of_base_checklist) AS best_pct,
            min(panini_coverage_audit.pct_of_base_checklist) AS worst_pct
           FROM panini_coverage_audit
          WHERE panini_coverage_audit.pct_of_base_checklist IS NOT NULL AND panini_coverage_audit.discovered_editions >= 30
        ), age AS (
         -- The per-EDITION walk-age distribution. `last_seen_at` is stamped unconditionally on
         -- every edition a walk touches (lib/chains/panini/ingest-normalize.ts), so it genuinely
         -- means "walked", not "changed".
         SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (now() - panini_editions.last_seen_at)) / 3600.0))::numeric, 1) AS p50_h,
            round((percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (now() - panini_editions.last_seen_at)) / 3600.0))::numeric, 1) AS p90_h,
            round((max(extract(epoch FROM (now() - panini_editions.last_seen_at)) / 3600.0))::numeric, 1) AS max_h,
            count(*) FILTER (WHERE panini_editions.last_seen_at <= (now() - '45 days'::interval)) AS stale_45d,
            round(100.0 * count(*) FILTER (WHERE panini_editions.last_seen_at <= (now() - '45 days'::interval))::numeric / NULLIF(count(*), 0)::numeric, 1) AS pct_stale_45d,
            count(*) FILTER (WHERE panini_editions.last_seen_at > (now() - '7 days'::interval)) AS walked_7d,
            round(100.0 * count(*) FILTER (WHERE panini_editions.last_seen_at > (now() - '7 days'::interval))::numeric / NULLIF(count(*), 0)::numeric, 1) AS pct_walked_7d
           FROM panini_editions
        )
 SELECT count(*) AS total_editions,
    count(*) FILTER (WHERE coverage_flag = 'broad'::text) AS trustworthy_editions,
    round(100.0 * count(*) FILTER (WHERE coverage_flag = 'broad'::text)::numeric / NULLIF(count(*), 0)::numeric, 1) AS pct_trustworthy,
    count(*) FILTER (WHERE coverage_flag = 'listing_gated'::text) AS listing_gated_editions,
    count(DISTINCT set_name) FILTER (WHERE coverage_flag = 'listing_gated'::text) AS listing_gated_families,
    count(DISTINCT set_name) AS families,
    max(newest_refresh_h) AS oldest_family_refresh_h,
    min(newest_refresh_h) AS newest_family_refresh_h,
    ( SELECT fam.best_pct
           FROM fam) AS best_family_checklist_pct,
    ( SELECT fam.worst_pct
           FROM fam) AS worst_family_checklist_pct,
    ( SELECT checklist.players
           FROM checklist) AS checklist_players_seen,
    ( SELECT checklist.new_24h
           FROM checklist) AS checklist_players_new_24h,
    -- >>> ADDED 2026-09-19: the per-edition age distribution the family MAX above cannot see.
    ( SELECT age.p50_h FROM age) AS edition_age_p50_h,
    ( SELECT age.p90_h FROM age) AS edition_age_p90_h,
    ( SELECT age.max_h FROM age) AS edition_age_max_h,
    ( SELECT age.stale_45d FROM age) AS editions_stale_45d,
    ( SELECT age.pct_stale_45d FROM age) AS pct_editions_stale_45d,
    ( SELECT age.walked_7d FROM age) AS editions_walked_7d,
    ( SELECT age.pct_walked_7d FROM age) AS pct_editions_walked_7d
   FROM per_edition c;

comment on view public.panini_coverage_summary is
  'Panini WC-Prizm coverage self-measure. ⚠ oldest_family_refresh_h / newest_family_refresh_h are MAX(last_seen_at) PER SET and cannot see the distribution inside a set: measured 2026-09-19, Base Prizms Aguila read family_newest_h=0.0 while 62.1% of its editions were 45+ days stale, and the 1,528h headline came from a one-edition set. Read edition_age_p50_h / edition_age_p90_h / pct_editions_stale_45d for the honest per-edition picture.';