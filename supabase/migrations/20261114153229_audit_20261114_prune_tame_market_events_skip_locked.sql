-- audit_20261114_prune_tame_market_events_skip_locked
-- #atlas-market-events-prune 40P01 deadlock fix (inbox 2026-11-14T0709Z; applied via Cowork apply_migration, version 20261114153229).
--
-- WHAT: append `FOR UPDATE SKIP LOCKED` to the temp-page SELECT inside
-- prune_topshot_atlas_market_events(int,int) (jobid 473, hourly :27). The prune
-- DELETEs aged completed `nba` rows from topshot_atlas_market_events; it threw
-- `deadlock detected` (40P01) on ~2/48 hourly runs because its row locks raced
-- the concurrent feed upsert (atlas_market_upsert_events) on overlapping tuples
-- (ShareLock-on-transaction). With SKIP LOCKED the prune never WAITS on a tuple a
-- writer holds -- it skips it this tick and takes it next tick. The prune is
-- idempotent and guarded (guard 1 = sales cursor, guard 2 = hydration need), so
-- skipped rows are pruned on a later run; ordering (oldest-first) unchanged.
-- Partner-agnostic: eliminates the prune's blocking wait regardless of the writer.
--
-- Applied as a md5-asserted catalog splice (pg_get_functiondef -> single-anchor
-- replace -> EXECUTE), base body md5 e98dbcf61d9d583169799ab94c871e41 ->
-- 6dd86d4f6237399f699adf89989d5847. anon/authenticated EXECUTE preserved false.
-- SECURITY DEFINER + search_path preserved. Positive control (real caller):
-- SELECT prune_topshot_atlas_market_events(7,20000) ran clean post-splice --
-- page 1171 / deleted 1171 / error null / kept_hydration 0.
--
-- REVERT: the inverse splice (removes the clause), base md5 6dd86d4f...:
--   DO $r$ DECLARE d text; BEGIN
--     d := pg_get_functiondef('public.prune_topshot_atlas_market_events(integer,integer)'::regprocedure);
--     IF md5(d) <> '6dd86d4f6237399f699adf89989d5847' THEN RAISE EXCEPTION 'md5 drift'; END IF;
--     EXECUTE replace(d, 'LIMIT p_max FOR UPDATE SKIP LOCKED;', 'LIMIT p_max;');
--   END $r$;

DO $mig$
DECLARE d text; d2 text; m text;
BEGIN
  d := pg_get_functiondef('public.prune_topshot_atlas_market_events(integer,integer)'::regprocedure);
  m := md5(d);
  IF m <> 'e98dbcf61d9d583169799ab94c871e41' THEN
    RAISE EXCEPTION 'prune_tame base md5 drift: got %, refusing splice', m;
  END IF;
  IF (length(d) - length(replace(d, 'LIMIT p_max;', ''))) <> length('LIMIT p_max;') THEN
    RAISE EXCEPTION 'splice anchor LIMIT p_max; not present exactly once';
  END IF;
  d2 := replace(d, 'LIMIT p_max;', 'LIMIT p_max FOR UPDATE SKIP LOCKED;');
  IF d2 = d THEN RAISE EXCEPTION 'splice produced no change'; END IF;
  IF position('DELETE FROM public.topshot_atlas_market_events' in d2) = 0 THEN
    RAISE EXCEPTION 'splice damaged the function body (lost base DELETE)';
  END IF;
  EXECUTE d2;
  IF position('FOR UPDATE SKIP LOCKED' in
      pg_get_functiondef('public.prune_topshot_atlas_market_events(integer,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'post-splice: FOR UPDATE SKIP LOCKED not present';
  END IF;
END $mig$;
