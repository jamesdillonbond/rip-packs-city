-- audit_20261127_sold_pack_seed_batch_and_backoff
--
-- 2026-11-27 (PT, ~4:05 PM; Claude Code cloud; Trevor: "Keep going ... leaving nothing unresolved").
--
-- WHY: the first manual run of run_seed_sold_pack_pulls on the new work list (20261127233707) took 91 s for its 4,000-pack batch -- still too close to the 90 s / 120 s
-- caps -- and it re-looked at every pack daily, though a pack whose pulls are on record never needs
-- seeding again.
--
-- WHAT (md5-asserted splice of seed_sold_pack_pulls, base md5 f504978c81e458525fadea52f4acedc0):
-- batch 4,000 -> 1,000; re-schedule: no rip yet 6 h, pulls on record 30 days, otherwise 7 days.
-- Steady state ~40k packs / 7 days ~= 240 a tick, well under the batch.
--
-- REVERT: re-apply seed_sold_pack_pulls from 20261127233707_audit_20261127_sold_pack_work_list.sql.

DO $mig$
DECLARE
  v_src text; v_new text; v_args text;
  c_a1 constant text := E'           ORDER BY seed_next_at\n           LIMIT 4000) w';
  c_b1 constant text := E'           ORDER BY seed_next_at\n           LIMIT 1000) w';
  c_a2 constant text := E'  -- re-schedule what was looked at: no rip yet 6 h; rows on record or nothing to seed 1 day\n  UPDATE public.sold_pack_work w\n     SET seed_next_at = now() + CASE WHEN d.no_rip THEN interval ''6 hours'' ELSE interval ''1 day'' END';
  c_b2 constant text := E'  -- re-schedule what was looked at: no rip yet 6 h; pulls on record 30 days; otherwise 7 days\n  UPDATE public.sold_pack_work w\n     SET seed_next_at = now() + CASE WHEN d.no_rip THEN interval ''6 hours''\n                                     WHEN d.has_rows THEN interval ''30 days''\n                                     ELSE interval ''7 days'' END';
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'seed_sold_pack_pulls';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'seed_sold_pack_pulls() not found';
  END IF;
  IF md5(v_src) <> 'f504978c81e458525fadea52f4acedc0' THEN
    RAISE EXCEPTION 'base drifted: prosrc md5 %', md5(v_src);
  END IF;
  IF (length(v_src) - length(replace(v_src, c_a1, ''))) / length(c_a1) <> 1
     OR (length(v_src) - length(replace(v_src, c_a2, ''))) / length(c_a2) <> 1 THEN
    RAISE EXCEPTION 'anchor not unique';
  END IF;
  v_new := replace(replace(v_src, c_a1, c_b1), c_a2, c_b2);
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.seed_sold_pack_pulls(%s) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS $f$%s$f$',
    v_args, v_new);
END
$mig$;

REVOKE ALL ON FUNCTION public.seed_sold_pack_pulls(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_sold_pack_pulls(integer) TO service_role;
