-- audit_20261122_panini_tier_shadow_rows_written_means_packs_written — 2026-11-22 ~6:35 PM PT (Claude Code cloud;
-- handoff-2026-11-22-daytime queue item 12, Trevor: "Keep going").
--
-- WHY. refresh_panini_pack_ev_tier_shadow() logs through log_pipeline_run(text, boolean, jsonb), which takes
-- rows_written from extra.upserted. The function puts its count in extra.packs_written instead, so every run since it
-- shipped (11-22 11:49 AM PT) logged rows_written = 0 while writing ~369 packs: a count that does not mean rows
-- written (R120), read as a zero-yield lane by the zero-yield and coverage arms. A sweep of every caller of that
-- overload found this the only one (the other without `upserted`, pack-ev-history-thin-heartbeat, is a heartbeat).
--
-- WHAT. Catalog splice (the body is ~12.5k chars and owned by the Panini thread; a retype risks drift): add
-- 'upserted', v_packs next to 'packs_written', v_packs in the success-path log call. Guarded: live prosrc md5 and
-- exactly one occurrence of the anchor. Nothing else changes. Resulting prosrc md5: 29ebbee6d26c9613c29e7277f66d82a4.
-- REVERT: the same splice in reverse (remove "'upserted', v_packs, " after 'packs_written', v_packs,).

DO $splice$
DECLARE
  v_def text;
  v_old constant text := $a$'packs_written', v_packs,$a$;
  v_new constant text := $a$'packs_written', v_packs, 'upserted', v_packs,$a$;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_panini_pack_ev_tier_shadow()'::regprocedure)
     IS DISTINCT FROM 'ddb7712854ca0e638f8790cdfe03342d' THEN
    RAISE EXCEPTION 'refresh_panini_pack_ev_tier_shadow drifted; re-read and re-base';
  END IF;
  v_def := pg_get_functiondef('public.refresh_panini_pack_ev_tier_shadow()'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'anchor must occur exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$splice$;
