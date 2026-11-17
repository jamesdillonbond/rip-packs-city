-- ─────────────────────────────────────────────────────────────────────────────
-- jobid 466 `rpc-ts-listings-atlas-sync`: */2 → */5.
--
-- MEASURED 2026-09-20 09:25 PT over the preceding 24 h:
--   717 ticks, 453 ok, 261 killed at the 120 s statement timeout (36 %).
--   Median successful tick 45 s.
--   12.5 DB-hours/day burned by this lane and the All Day resolver on ticks
--   that hit the wall and ROLLED BACK, writing nothing at all.
--   Longest stretch with no successful tick: 99 minutes — on a lane scheduled
--   every 2 minutes. So this is not cosmetic noise; the lane is degraded.
--
-- WHY CADENCE AND NOT THE USUAL LEVERS.
--   * "Cut items per tick" is nearly exhausted: `atlas_listing_verify_tick(2)`
--     already takes 2, and p_max bounds only ONE of the tick's SIX steps.
--   * The differential-upsert probe shape is ALREADY fixed — both
--     `sync_ts_listings_from_atlas` and `sync_cached_listings_from_atlas` carry
--     the R101 v2 delta-first rewrite, and the cheap sibling is cheap because
--     it REUSES the `_open24` temp table the first one built, not because it is
--     better written. (I chased both of these before measuring. Recording them
--     so the next session does not.)
--   * The real cost is a cold rebuild of the ~60,350-row open book every 2 min
--     to write ~100 changed rows. Two consecutive ticks, 09:02 and 09:04 PT:
--     6.7 s warm (166 ins / 97 del) vs 66.8 s for ZERO rows written. Cheap warm
--     + expensive cold is IO-bound, so no index helps — only doing it less does.
--
-- WHY NOT RAISE THE BUDGET INSTEAD. At a 2-minute cadence a longer timeout just
-- overlaps ticks on a 2-core instance. Cadence and budget are one decision; this
-- changes the half that reduces work.
--
-- FRESHNESS IS SAFE. Measured effective update interval today is already ~3 min
-- (64 % of ticks succeeding), and the Order Book Depth card gates on a 6 h
-- freshness window (see the migration immediately preceding this one). A 5 min
-- cadence is ~72x inside that gate. `*/5` keeps minutes 0 and 30, so the tick's
-- twice-hourly diagnostic sampling (`minute % 30 < 2`) still fires.
--
-- EXIT (re-measure over a full 24 h, not sooner — a window sitting entirely
-- after a change point cannot tell a step from a level):
--   kill rate well under 36 %, longest no-success gap well under 99 min.
-- FALSIFIER: if the kill rate holds near 36 % on a 5-minute cadence, the cost is
-- not contention between ticks and the lever is the book rebuild itself
-- (materialise `_open24` across ticks, or narrow the 24 h window).
--
-- REVERT: select cron.schedule('rpc-ts-listings-atlas-sync', '*/2 * * * *',
--                              'SELECT public.atlas_listing_verify_tick(2)');
-- ─────────────────────────────────────────────────────────────────────────────
SELECT cron.schedule(
  'rpc-ts-listings-atlas-sync',
  '*/5 * * * *',
  'SELECT public.atlas_listing_verify_tick(2)'
);
