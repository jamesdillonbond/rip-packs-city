-- audit_20261117_topshot_low_mint_cap_suffix — 2026-11-17 ~7:35 AM PT (Claude Code cloud), follow-up to
-- 20261117150011. That migration re-stamped 573 latest Top Shot ASK_ONLY snapshots with the suffix `_lowmintcap`,
-- which no reader knows: lib/fmv-basis isSalesCappedAlgo and get_edition_detail's basis_capped both read
-- `_(salescap|histcap)(_bidfloor)?$`, so those prices still said "from asks" instead of "capped at sales". This
-- swaps the suffix for the one the trigger itself writes for the same cap: `_salescap` when the last ordinary sale
-- is within 180 days, else `_histcap`. Price unchanged.
--
-- REVERT: UPDATE public.fmv_snapshots f SET algo_version = COALESCE(b.old_algo_version, '') || '_lowmintcap'
--   FROM public.audit_20261117_topshot_ask_only_low_mint_cap_backup b WHERE f.id = b.snapshot_id;
UPDATE public.fmv_snapshots fs
   SET algo_version = COALESCE(b.old_algo_version, '') ||
       CASE WHEN EXISTS (
              SELECT 1 FROM public.sales_market y
               JOIN public.editions e ON e.id = y.edition_id
              WHERE y.edition_id = b.edition_id
                AND y.sold_at > now() - interval '180 days'
                AND y.price_usd > 0
                AND y.serial_number IS NOT NULL AND y.serial_number <> 1
                AND y.serial_number IS DISTINCT FROM NULLIF(e.jersey_number, 0)::int
                AND y.serial_number <> e.circulation_count)
            THEN '_salescap' ELSE '_histcap' END
  FROM public.audit_20261117_topshot_ask_only_low_mint_cap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.algo_version = COALESCE(b.old_algo_version, '') || '_lowmintcap';

DO $chk$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.fmv_snapshots fs
    JOIN public.audit_20261117_topshot_ask_only_low_mint_cap_backup b ON fs.id = b.snapshot_id
   WHERE fs.algo_version LIKE '%\_lowmintcap';
  IF n > 0 THEN RAISE EXCEPTION '% rows still carry _lowmintcap', n; END IF;
END
$chk$;
