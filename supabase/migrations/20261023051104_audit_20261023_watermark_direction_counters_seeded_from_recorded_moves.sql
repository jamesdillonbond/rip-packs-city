-- audit_20261023_watermark_direction_counters_seeded_from_recorded_moves
--
-- Follow-up to 20261023050947 (same pass, ~10:12 PM PT 10-22). That migration started every
-- cursor's new increases/decreases counters at 0/0 except the one it corrected, which
-- DISARMED the one genuine backward walker on record: `golazos_sales_v1_backfill` reached
-- the spork floor (137,390,146) on 10-01 and is dormant, so with 0/0 it would never
-- re-arm, and a re-seed to CEILING_INIT — the exact defect the arm exists for — would
-- go uncounted. The facts to seed from are already in the row:
--   • ever_decreased, rewind_count 0, sitting AT its low water  ⇒ every recorded move
--     was a descent  ⇒ decreases = changes_observed;
--   • never decreased, rewind_count 0, sitting AT its high water ⇒ every recorded move
--     was an ascent  ⇒ increases = changes_observed.
-- Rows that fit neither shape (none today besides the already-seeded walk) are left for
-- the observer to re-learn. UPDATE only; no function or table change.
-- anon-exec: none — data-only migration, no function created or replaced.
-- REVERT: UPDATE public.event_cursor_watermarks SET increases = 0, decreases = 0
--   WHERE cursor_id <> 'topshot_missing_fill_offers_walk';
UPDATE public.event_cursor_watermarks
   SET decreases = changes_observed, increases = 0
 WHERE ever_decreased AND rewind_count = 0 AND last_seen_block = low_water
   AND increases = 0 AND decreases = 0 AND changes_observed > 0;

UPDATE public.event_cursor_watermarks
   SET increases = changes_observed, decreases = 0
 WHERE NOT ever_decreased AND rewind_count = 0 AND last_seen_block = high_water
   AND increases = 0 AND decreases = 0 AND changes_observed > 0;
