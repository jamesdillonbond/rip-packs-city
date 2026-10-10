-- audit_20261010_topshot_atlas_pack_ev_watch_promoted_to_medium
--
-- #79's owed step: the topshot-atlas-pack-ev cadence watch was seeded at `info` "until a
-- human read of the first weeks promotes it". Read 2026-10-10 ~3:15 PM PT: 76 of 76 runs
-- ok in the retained window, max gap 60 min against the 183 min threshold. Promoted to
-- medium (decided under Trevor's "do what you think is best").
--
-- Revert: UPDATE public.pipeline_cadence_watchlist SET severity = 'info'
--          WHERE pipeline = 'topshot-atlas-pack-ev';

UPDATE public.pipeline_cadence_watchlist
   SET severity = 'medium',
       notes = notes || ' | 2026-10-10: promoted info -> medium (#79). Read first: 76/76 runs ok in the retained window, max gap 60 min vs the 183 min threshold. Revert: severity = ''info''.'
 WHERE pipeline = 'topshot-atlas-pack-ev' AND severity = 'info';
