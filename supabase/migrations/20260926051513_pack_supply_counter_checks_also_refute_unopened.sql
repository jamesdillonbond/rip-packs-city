-- 2026-09-25 (PT) — the counter checks also refute an UNOPENED/SEALED count:
-- a pack we watched open AFTER a counter's stamp was still sealed AT it.
--
-- WHY. 20260926050031 refuted a counter only when it claimed too FEW opened.
-- The live pack page for dist 8643 then fell through to the EV snapshot's
-- claim — `total_unopened = 0`, `depletion_pct = 100` at 2026-08-27 19:55 PT —
-- and rendered "Packs remaining 0". We observed 150 of its packs opened AFTER
-- that instant, so at least 150 were sealed then: the 0 is refuted by the same
-- floor. (The same v20 write put 6,000-of-6,000 unopened in metadata at the
-- same instant — one writer, one stamp, opposite answers.)
--
-- WHAT. Guarded splice of refresh_pack_supply_counter_checks() (each anchor
-- exactly once or RAISE), adding the upper-bound arm to each verdict:
--   pd   : opens after supply_as_of  > total_minted - total_opened (minted > 0)
--   pev  : opens after snapshotted_at > total_unopened
--   tier : opens after the tier stamp  > metadata total_unopened
-- Measured before: +122 pev, +2 tier, +5 pd. View unchanged (it already NULLs
-- total_unopened / depletion on pev_bad).
--
-- Revert: the three replacements in reverse, then SELECT refresh_…().

-- anon-exec: unchanged (refresh_pack_supply_counter_checks) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-25).
DO $mig$
DECLARE
  v_src text;
  v_new text;
  v_n int;
  v_i int;
  olds text[] := ARRAY[
    $q$         (o.n_sup > d.total_opened) OR (d.total_minted > 0 AND o.n_all > d.total_minted),
$q$,
    $q$                  AND o.n_pev > floor(d.pev_tu * (d.pev_dep + 0.5) / (100 - d.pev_dep - 0.5)), false),
$q$,
    $q$                  AND (o.n_tier > d.tier_tp - d.tier_tu OR o.n_all > d.tier_tp), false)
$q$
  ];
  reps text[] := ARRAY[
    $q$         (o.n_sup > d.total_opened) OR (d.total_minted > 0 AND o.n_all > d.total_minted)
         -- a pack opened after the stamp was sealed at it
         OR (d.total_minted > 0 AND o.n_all - o.n_sup > d.total_minted - d.total_opened),
$q$,
    $q$                  AND o.n_pev > floor(d.pev_tu * (d.pev_dep + 0.5) / (100 - d.pev_dep - 0.5)), false)
         OR COALESCE(d.pev_at IS NOT NULL AND d.pev_tu IS NOT NULL AND o.n_all - o.n_pev > d.pev_tu, false),
$q$,
    $q$                  AND (o.n_tier > d.tier_tp - d.tier_tu OR o.n_all > d.tier_tp
                       OR o.n_all - o.n_tier > d.tier_tu), false)
$q$
  ];
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'refresh_pack_supply_counter_checks';
  IF v_src IS NULL THEN RAISE EXCEPTION 'refresh_pack_supply_counter_checks not found'; END IF;
  v_new := v_src;
  FOR v_i IN 1..3 LOOP
    v_n := (length(v_new) - length(replace(v_new, olds[v_i], ''))) / length(olds[v_i]);
    IF v_n <> 1 THEN RAISE EXCEPTION 'anchor % matched % times', v_i, v_n; END IF;
    v_new := replace(v_new, olds[v_i], reps[v_i]);
  END LOOP;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.refresh_pack_supply_counter_checks() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' SET statement_timeout TO ''120s'' AS %L',
    v_new);
END
$mig$;

SELECT public.refresh_pack_supply_counter_checks();

DO $post$
DECLARE r record; bad int;
BEGIN
  -- 8643: the "0 remaining" the page fell through to is now withdrawn.
  SELECT total_unopened, depletion_pct, ev_depletion_pct INTO r FROM public.pack_table_rows
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND dist_id = '8643';
  IF r.total_unopened IS NOT NULL OR r.depletion_pct IS NOT NULL OR r.ev_depletion_pct IS NOT NULL THEN
    RAISE EXCEPTION '8643 still publishes (%, %, %)', r.total_unopened, r.depletion_pct, r.ev_depletion_pct;
  END IF;
  -- No published unopened count is below the packs we watched open after it.
  SELECT count(*) INTO bad FROM public.pack_table_rows t
    JOIN public.pack_supply_counter_checks k USING (collection_id, dist_id)
   WHERE t.total_unopened IS NOT NULL AND k.pev_snapshotted_at = t.ev_snapshotted_at
     AND k.observed_opened - k.observed_by_pev > t.total_unopened;
  IF bad <> 0 THEN RAISE EXCEPTION '% published total_unopened below the post-stamp opens', bad; END IF;
  IF has_function_privilege('anon', 'public.refresh_pack_supply_counter_checks()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refresh_pack_supply_counter_checks()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL widened';
  END IF;
END
$post$;
