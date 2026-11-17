-- 2026-08-04 · v_rpc_trust_health: correct the `catches` text on the *_fmv_pct_stale_30d
-- family so it states what was measured rather than what was hoped.
--
-- NO breach_at IS CHANGED BY THIS MIGRATION. Text only. It cannot blind an arm.
--
-- Applied as a targeted string replacement against pg_get_viewdef rather than a retyped
-- 30-arm CREATE OR REPLACE VIEW, so a transcription slip cannot silently drop or alter an
-- unrelated arm. Each replacement RAISEs if its anchor is absent, so a drifted view fails
-- LOUD instead of applying half the change.
--
-- ⚠ CREATE OR REPLACE VIEW DROPS reloptions -- security_invoker=on is re-set below in the
-- same transaction. This has bitten twice in three days.

DO $mig$
DECLARE
  v_def text;
  v_new text;
  c_old_ts   text;
  c_new_ts   text;
  c_old_ad   text;
  c_new_ad   text;
  c_old_cd   text;
  c_new_cd   text;
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO v_def;
  v_new := v_def;

  ---------------------------------------------------------------------------
  -- 1. topshot_fmv_pct_stale_30d
  ---------------------------------------------------------------------------
  c_old_ts := 'COVERAGE leg (baseline 32.3% on 2026-07-25): share of priced TopShot editions whose LATEST FMV is >30d old. topshot_fmv_stale_hours reads only the FRESHEST row, so it stays green at 0.1h while a repricing backlog builds; this catches a partial/selective writer stall the freshness sentinel structurally cannot see. PRECOMPUTED (2026-07-25): the inline whole-table DISTINCT ON over fmv_snapshots pushed this view past the 30s service_role budget, which made the monitor fail BLIND (a timeout reads as "0 breaches"); now read from rpc_trust_health_precompute, refreshed 6-hourly, with a missing/>24h row reporting 999 and BREACHING';

  c_new_ts := 'COVERAGE leg, TOPSHOT CANONICAL ONLY as of 2026-08-04: share of canonical TopShot editions (external_id matching ^[0-9]+:[0-9]+(::[0-9]+)?$) whose LATEST fmv_snapshots.computed_at is >30d old. THIS ARM IS INERT BY DESIGN AND ITS ORIGINAL PURPOSE WAS DISPROVED. Three findings, all measured 2026-08-04. (1) MIS-ATTRIBUTION, now fixed: it read 32.2% and 6263 of 6263 stale editions were non-canonical UUID-keyed dupe residue, canonical stale being 0 with worst age 7.0d. So 100% of the headline came from a population ts_uuid_dupes_created_24h already watches, and a dupe-growth event would have paged as a TopShot FMV repricing stall -- a wrong diagnosis, worse than no arm. edition_integrity_flags already excludes the same residue; the canonical predicate makes this leg match it. (2) THE STATED PURPOSE FAILS A BACK-TEST. The old text claimed it catches a partial or selective writer stall that topshot_fmv_stale_hours structurally cannot see. Evaluated as-of during the 2026-07-20..08-03 fmv-recalc sweep stall -- the exact outage, with 74% of the catalogue never recomputed -- the canonical form read 0.00% on every probe date (07-20, 07-25, 07-29, 08-02, 08-03). It could not have fired. Reason: computed_at records WHEN ANY WRITER LAST TOUCHED THE ROW, not when FMV was recomputed from sales, and TopShot has 8+ concurrent writers (1.7.0, cold-tail-1.0, topshot-gql-v1, thin-sales-guard-v3, ultimate-v1 and haircut variants) that between them touched all 13,021 canonical editions inside ~7d while the sweep was 74% dead. Peak-stall profile on 08-02: 33.7% >3d, 11.7% >5d, 0.1% >7d, 0.0% >10d, 0.0% >14d. A 30d test on this column CANNOT FIRE. (3) THE WHOLE FAMILY SHARES THE CEILING: max latest-FMV age is AllDay 7.00d, Golazos 6.96d, Candy 0.38d, TopShot canonical 7.00d, so allday/golazos/candy_fmv_pct_stale_30d are 4x or more above their structural ceiling and are equally unbreachable. Only ufc_fmv_pct_stale_30d carries signal, and only because UFC has no live writer. breach_at DELIBERATELY LEFT AT 50, NOT re-baselined: the value now reads 0.0, but the healthy steady state is one day old (sweep fixed 2026-08-03) and setting a threshold off one day would repeat the exact error of the 2026-07-25 baseline of 32.3%, captured while the sweep was already stuck. RE-BASELINE ON OR AFTER 2026-08-18 (14d of healthy history) and switch the cut from 30d to 3d: the stalled-vs-healthy separation lives there (stalled 49.4/40.1/48.2/41.9% on 07-22/26/30 and 08-02 vs healthy 19.1% on 08-04), while >7d shows no separation at all (0.2-0.7% stalled vs 0.4% healthy). Successor arm: pct of canonical TopShot editions with latest computed_at older than 3d, breach_at ~2x the settled healthy value. Until that re-baseline, fmv_sweep_stall_pct_24h is the live stall detector and this arm is a placeholder holding its slot. PRECOMPUTED (2026-07-25): inline it pushed this view past the 30s service_role budget and a timeout reads as 0 breaches, i.e. the monitor fails BLIND; a missing or >24h-old precompute row reports 999 and BREACHES.';

  v_new := replace(v_new, c_old_ts, c_new_ts);
  IF v_new = v_def AND position(c_new_ts in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor not found: topshot_fmv_pct_stale_30d catches text';
  END IF;

  ---------------------------------------------------------------------------
  -- 2. allday + golazos (identical trailing marker, one replace covers both)
  ---------------------------------------------------------------------------
  c_old_ad := 'PRECOMPUTED (2026-07-25) — see topshot_fmv_pct_stale_30d';
  c_new_ad := 'STRUCTURALLY UNBREACHABLE at 30d, measured 2026-08-04: the max latest-FMV age of ANY edition is 7.00d (AllDay) / 6.96d (Golazos), so a 30d test sits over 4x above the ceiling and cannot fire at any threshold. computed_at records when any writer last touched the row, not when FMV was recomputed. Treat as a placeholder; the successor cut is >3d. PRECOMPUTED (2026-07-25) — see topshot_fmv_pct_stale_30d';

  IF position(c_old_ad in v_new) = 0 AND position(c_new_ad in v_new) = 0 THEN
    RAISE EXCEPTION 'anchor not found: allday/golazos catches marker';
  END IF;
  v_new := replace(v_new, c_old_ad, c_new_ad);

  ---------------------------------------------------------------------------
  -- 3. candy
  ---------------------------------------------------------------------------
  c_old_cd := '-- see topshot_fmv_pct_stale_30d for the timeout-blindness rationale';
  c_new_cd := '-- STRUCTURALLY UNBREACHABLE at 30d, measured 2026-08-04: the max latest-FMV age across all 125 Candy editions is 0.38d, so a 30d test sits ~79x above the ceiling and cannot fire at any threshold. Treat as a placeholder; the successor cut is >3d. See topshot_fmv_pct_stale_30d for the back-test, and for the timeout-blindness rationale';

  IF position(c_old_cd in v_new) = 0 AND position(c_new_cd in v_new) = 0 THEN
    RAISE EXCEPTION 'anchor not found: candy catches marker';
  END IF;
  v_new := replace(v_new, c_old_cd, c_new_cd);

  ---------------------------------------------------------------------------
  IF v_new = v_def THEN
    RAISE EXCEPTION 'no change produced -- refusing to replace the view';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
  -- MANDATORY: CREATE OR REPLACE VIEW drops reloptions.
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END
$mig$;