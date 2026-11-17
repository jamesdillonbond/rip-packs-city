-- Series 2026-27 (on-chain series 9) tip-off verification — read-only, run with execute_sql.
-- Pre-staged 2026-10-18 for the scheduled check on 10-20 (task trig_01WkbSku…, 7:00 PM PT).
-- Every query below was run against prod 10-18 ~10:15 AM PT: series-9 counts all 0; with series=8
-- substituted, Q2 read 1,854 base editions / 0 null / 1 without an Atlas row / 0 above Atlas, Q3 read
-- 'Series 2025-26', Q4 513,786 index rows / 1,063 backfill unwalked / 7,470 candidates added in 24 h /
-- walk 9 of 9 ok-unbudgeted, Q5 2,272 complete. Substitute 8 for 9 to get a control row.
-- Numbers in comments are DATED SAMPLES; re-derive, do not quote.
--
-- TIMING (all PT, 10-20): sets appear first; collection_series 9 lands at the next run of
-- topshot-set-series-onchain (every 10 min at :x5 since 10-18; it was hourly at :35, so new sets read
-- "No series" for up to ~70 min — now up to ~20); on-chain circulation
-- runs every 6 h since 10-18 (3:05 PM and 9:05 PM on 10-20) and pack-dist names every 3 h at :25
-- (5:25 PM, 8:25 PM). Both were once a day (~9:05 / ~9:25 PM). The 7 PM check sees the 3:05 PM
-- circulation and 5:25 PM names; re-run Q2 after 9:10 PM for the evening drop.

-- Q1 sets + series row + unlabelled-series failures in the last 24 h
select (select count(*) from sets s
         where s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' and s.series = 9) as series9_sets,
       (select count(*) from sets s
         where s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' and s.series is null
           and s.created_at > now() - interval '3 days') as new_sets_without_series,
       (select display_label from collection_series cs
         where cs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' and cs.series_number = 9) as series9_label,
       (select count(*) filter (where not ok) || ' failed of ' || count(*)
          from pipeline_runs where pipeline ilike '%set-series%' and started_at > now() - interval '24 hours') as set_series_runs_24h;

-- Q2 series-9 base editions vs Atlas circulation (above_atlas must be 0 once pg_cron 457 has run)
select count(*) as series9_base_editions,
       count(*) filter (where e.circulation_count is null) as circulation_null,
       count(*) filter (where b.circulation_count is null) as no_atlas_row,
       count(*) filter (where e.circulation_count > b.circulation_count) as above_atlas,
       count(*) filter (where e.tier is null) as tier_null,  -- Market/sniper tier filters (sniper Next 3); 0 of 1,854 on series 8
       count(*) filter (where e.set_name is null or e.player_name is null) as name_null  -- 0 of 1,854 on series 8
  from editions e
  left join badge_editions b on b.external_id = e.external_id
   and b.collection_id = e.collection_id
 where e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   and e.series = 9 and e.external_id ~ '^[0-9]+:[0-9]+$';

-- Q3 analytics label (fixed 10-18 by 20261018162955; pinned). Expect one row 'Series 2026-27' once
--    series-9 sets exist; 'Series 9' or a blank label is the regression.
select series, series_label, set_count, edition_count
  from analytics_sets_series_overview(array['topshot'])  -- short key; 'nba_top_shot' returns NO rows
 where series >= 8 order by series;

-- Q4 ownership index on series-9 editions + walk health
select (select count(*) from topshot_ownership o
          join editions e on e.external_id = o.edition_external_id
           and e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
         where e.series = 9 and o.walk_missed_at is null) as series9_index_rows,
       (select count(*) from topshot_ownership_walk_candidates
         where source = 'series8_era_backfill' and last_walked_at is null) as backfill_unwalked, -- 1,063 at 10-18 9:40 AM
       (select count(*) from topshot_ownership_walk_candidates
         where added_at > now() - interval '24 hours') as candidates_added_24h, -- 7,470 at 10-18
       (select count(*) filter (where ok and extra->>'budget_hit' = 'false')  -- absent key = unknown, not ok
               || ' ok-unbudgeted of ' || count(*)
          from pipeline_runs where pipeline = 'ownership-onchain-walk'
           and started_at > now() - interval '24 hours') as walk_runs_24h;

-- Q5 squeeze-board census (2,272 complete on 10-17 2 PM and 10-18 9:40 AM — a real plateau)
select count(*) filter (where census_complete) as census_complete, count(*) as editions,
       max(computed_at) at time zone 'America/Los_Angeles' as computed_at_pt
  from topshot_edition_concentration;

-- Q6 not SQL: lib/packs/live-pack-listings.ts labels by DATE with a 10-19 5 PM PT cutoff — a Series 8
--    pack dropped that evening reads "Series 2026-27". Check the live packs page by rendered DOM.
--    Confirm TopShot.currentSeries = 9 on chain before trusting any label.
