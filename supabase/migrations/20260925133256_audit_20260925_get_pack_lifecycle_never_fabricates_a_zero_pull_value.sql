-- 2026-09-25 (PT) — get_pack_lifecycle(p_pack_nft_id) fabricated a $0 pull
-- value for every ripped pack whose pulls are not indexed.
--
-- WHY. Its pulls aggregate wrapped the FMV sum in COALESCE(SUM(...), 0), so a
-- pack with "Ripped — 4 moments pulled · No pulls indexed yet" published
-- "PULLED $0", "Gross pull value $0" and, where the buy price is known,
-- "−$<cost> vs cost" — a fabricated LOSS on a public page, at HTTP 200, on
-- the OG card too (it reads the same field). Measured 6:35 AM PT: 3,394,566
-- of 3,702,271 pack_rips (92%) have no moment_acquisitions row, so this was
-- the DEFAULT rendering of a pack page, not an edge. The sibling
-- get_pack_lifecycle_row (the /pack/dist/ page) had exactly this fixed on
-- 2026-08-01 (20260801204912, "never fabricate zero"); this function carried
-- the same expression and was not grepped for it.
--
-- WHAT. Drop the COALESCE: SUM over no priced pull is NULL, which fmtUsd()
-- already renders as "—", the delta/ROI lines already skip, and the page now
-- captions a PARTIAL sum ("3 of 4 pulls priced"). Applied as a guarded
-- SPLICE on the live body (this function has no committed definition; the
-- anchor must match exactly once or the migration RAISEs), header preserved
-- from pg_proc (STABLE, SECURITY DEFINER, search_path=public); ACL unchanged
-- (postgres, service_role). Revert: put the COALESCE(…, 0) back with the
-- same splice.

-- anon-exec: intentional — get_pack_lifecycle is called with the service client only (ACL unchanged by CREATE OR REPLACE: postgres, service_role; REVOKEd from anon/authenticated in 20260731213000).
DO $$
DECLARE
  v_src  text;
  v_new  text;
  v_old  constant text := E'    COALESCE(SUM((p->>''current_fmv'')::numeric), 0)\n  INTO v_pulls, v_pull_count, v_pulls_with_fmv, v_gross_pull_value';
  v_rep  constant text := E'    -- 2026-09-25: NULL, never 0, when no pull is priced — 92% of rips have no\n    -- indexed pulls, and "PULLED $0 · −$cost vs cost" was a fabricated loss.\n    SUM((p->>''current_fmv'')::numeric)\n  INTO v_pulls, v_pull_count, v_pulls_with_fmv, v_gross_pull_value';
  v_n    int;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_pack_lifecycle'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pack_nft_id text';
  IF v_src IS NULL THEN RAISE EXCEPTION 'get_pack_lifecycle(text) not found'; END IF;
  v_n := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'get_pack_lifecycle: expected the COALESCE(SUM(current_fmv), 0) anchor exactly once, found %', v_n;
  END IF;
  v_new := replace(v_src, v_old, v_rep);
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_pack_lifecycle(p_pack_nft_id text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public'' AS %L',
    v_new);
END $$;

-- Post-conditions. (1) The splice landed. (2) Positive control: a ripped pack
-- with no indexed pull now reports gross NULL (not 0). (3) No-change control:
-- a pack whose pulls ARE priced still reports a non-null sum.
DO $$
DECLARE v_src text; v_id text; v_stats jsonb;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'get_pack_lifecycle' AND pronamespace = 'public'::regnamespace;
  IF position('COALESCE(SUM((p->>''current_fmv'')::numeric), 0)' IN v_src) > 0 THEN
    RAISE EXCEPTION 'get_pack_lifecycle still COALESCEs the pull sum to 0';
  END IF;

  SELECT pr.pack_nft_id INTO v_id FROM public.pack_rips pr
   WHERE NOT EXISTS (SELECT 1 FROM public.moment_acquisitions ma WHERE ma.source_pack_rip_id = pr.id)
   ORDER BY pr.sealed_at DESC LIMIT 1;
  IF v_id IS NOT NULL THEN
    v_stats := public.get_pack_lifecycle(v_id)->'stats';
    IF (v_stats->>'gross_pull_value_usd') IS NOT NULL OR (v_stats->>'pull_count')::int <> 0 THEN
      RAISE EXCEPTION 'unindexed rip % still reports gross % with pull_count %', v_id, v_stats->>'gross_pull_value_usd', v_stats->>'pull_count';
    END IF;
  END IF;

  SELECT pr.pack_nft_id INTO v_id FROM public.pack_rips pr
   WHERE EXISTS (
     SELECT 1 FROM public.moment_acquisitions ma
     JOIN public.moments m ON m.nft_id = ma.nft_id AND m.collection_id = ma.collection_id
     JOIN public.fmv_snapshots fs ON fs.edition_id = m.edition_id AND fs.collection_id = ma.collection_id
     WHERE ma.source_pack_rip_id = pr.id AND fs.fmv_usd IS NOT NULL)
   ORDER BY pr.sealed_at DESC LIMIT 1;
  IF v_id IS NOT NULL THEN
    v_stats := public.get_pack_lifecycle(v_id)->'stats';
    IF (v_stats->>'gross_pull_value_usd') IS NULL THEN
      RAISE EXCEPTION 'priced rip % lost its gross pull value', v_id;
    END IF;
  END IF;
END $$;
