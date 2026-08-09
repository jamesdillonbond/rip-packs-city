-- 2026-08-08 — v_rpc_trust_health: correct the `ufc_fmv_pct_stale_30d` arm's embedded note.
-- Note text only; the value expression and breach_at (99.5) are byte-identical to what was live.
--
-- Applied to prod via Supabase MCP as migration 20260808202236. The repo record was never
-- committed — found and closed 2026-08-09 by the `migration-parity` sweep.
--
-- ⚠⚠ SUPERSEDED — DO NOT RE-RUN. THIS FILE IS HISTORY, NOT A REPLAYABLE STEP.
--   The arm this migration edits was RETIRED hours later, on 2026-08-09, by
--   `20260809145547_audit_20260809_retire_ufc_pct_stale_arm_add_precompute_freshness_arm.sql`
--   (it was a dated fuse: the metric reaches 100.0 on 2026-09-03 against a breach at 99.5, and a
--   percentage cannot exceed 100, so it would have gone permanently red). Its anchor
--   `SELECT 'ufc_fmv_pct_stale_30d'::text AS text,` no longer exists in the view, so the guarded
--   splice below would RAISE `ABORT: anchor matched 0 times, expected exactly 1` — which is the
--   guard behaving correctly, not a bug. This is committed only so the repo can describe how prod
--   reached its 2026-08-08 state; the repo's migrations are incremental patches over an
--   externally-created base and are never replayed from scratch (see CLAUDE.md).
--
-- ⚠ ONE CLAIM IN THE NOTE BELOW IS ITSELF WRONG, and the retirement migration corrected it:
--   the note asserts retiring the arm is "a TWO-PART change" also requiring the metric be stripped
--   from `rpc_trust_health_precompute_refresh()`. Re-measured 2026-08-09: it is ONE part. The
--   metric is a single row of the `want` VALUES list LEFT JOINed to an aggregate Legs 2–5 already
--   computes, so its marginal cost is zero — and it MUST keep refreshing, because the new
--   `trust_precompute_max_age_hours` arm reads max(age) over ALL rows and freezing one would peg
--   that arm red forever. Read the retirement migration, not this note.
--
-- WHAT IT FIXED (still worth reading — this is the durable lesson): the pre-correction note carried
--   a clause pasted from the AllDay and Golazos arms of the same metric family, claiming the max
--   latest-FMV age of any edition is 7.00d, so a 30d test sits 4x above the ceiling and cannot fire
--   at any threshold. False for UFC and actively misleading. Measured across all 465 UFC editions
--   holding a latest snapshot: max age 67.79d, median 67.77d, min 4.58d, 447/465 already past 30d —
--   which IS the 96.1 reading. A note copied between sibling arms silently carried another
--   collection's measurements.
--
-- REVERT: superseded — reverting is meaningless (the arm no longer exists). To undo the RETIREMENT
--   instead, see the revert path in 20260809145547_*.sql.

DO $mig$
DECLARE
  v_def      text;
  v_new      text;
  v_arm      text;
  v_anchor   text := 'SELECT ''ufc_fmv_pct_stale_30d''::text AS text,';
  v_start    int;
  v_len      int;
  v_tail     text;
  v_hits     int;
  v_u_before int;
  v_u_after  int;
BEGIN
  v_def := pg_get_viewdef('public.v_rpc_trust_health'::regclass, true);

  IF position('CORRECTED 2026-08-08' in v_def) > 0 THEN
    RAISE EXCEPTION 'ABORT: correction already applied';
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'ABORT: anchor matched % times, expected exactly 1', v_hits;
  END IF;

  v_start := position(v_anchor in v_def);
  v_tail  := substring(v_def from v_start);
  v_len   := position('UNION ALL' in v_tail) - 1;
  IF v_len <= 0 THEN RAISE EXCEPTION 'ABORT: no terminating UNION ALL after the arm'; END IF;

  v_u_before := (length(v_def) - length(replace(v_def, 'UNION ALL', ''))) / length('UNION ALL');

  -- value expression and breach_at are BYTE-IDENTICAL to what is live; only the note changes.
  v_arm := $arm$SELECT 'ufc_fmv_pct_stale_30d'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'ufc_fmv_pct_stale_30d'::text), 999::numeric) AS "coalesce",
            99.5 AS "numeric",
            'COVERAGE leg: share of UFC editions whose LATEST FMV is >30d old. UFC Flow trading is dead since 2026-05-13, so a HIGH baseline is HONEST (no sales = nothing to reprice); breach_at 99.5 sits above that floor. Threshold history, because this one has been mis-set twice: 90 -> 101 (a percentage cannot exceed 100, so it was UNBREACHABLE) -> 98 on 2026-08-01 (only 1.9pp above the live 96.1, so it would page on ordinary drift) -> 99.5 on 2026-08-02, Trevor-confirmed. Do NOT raise it above 100. ** CORRECTED 2026-08-08 ** this note previously carried a clause, pasted from the AllDay and Golazos arms of the same family, stating that the max latest-FMV age of ANY edition is 7.00d so a 30d test sits 4x above the ceiling and cannot fire at any threshold. That is FALSE FOR UFC and was actively misleading: those were the AllDay and Golazos ceilings. Measured 2026-08-08 across all 465 UFC editions holding a latest snapshot: max age 67.79d, median 67.77d, min 4.58d, and 447 of 465 already exceed 30d, which IS the 96.1 reading. ** THIS ARM IS SCHEDULED TO BREACH AND HAS NO THRESHOLD REMEDY ** the UFC FMV writer switched itself off on 2026-08-03 (confidence-cap trigger made Step 6 of /api/fmv-recalc unable to reselect these rows); the final write was 2026-08-04 06:31:44Z. Only 18 editions remain under the 30d line and each ages one day per day, so the metric reaches 100.0 on 2026-09-03 06:31:44Z, which is >= 99.5. Because the threshold cannot exceed 100, on that date this becomes a PERMANENT RED, exactly like the ufc FMV staleness arm re-pointed on 2026-08-08. CORRECT ACTION ON OR BEFORE 2026-09-03: retire or re-base, do NOT re-threshold. ** Retiring is a TWO-PART change, not a one-line splice ** rpc_trust_health_precompute_refresh() also computes this metric, so removing the arm alone leaves an orphaned precompute row still refreshed against a saturated instance. Deliberately NOT done on 2026-08-08: a multi-part change to a hot precompute path at the tail of a long session is the shape twice declined this week. REVIVAL IS ALREADY COVERED ELSEWHERE: ufc_flow_revival_sales_30d fires on the first UFC-on-Flow sale, immediately and independently of this arm; if that fires, re-base this one DOWN to about 3x the new steady state. PRECOMPUTED - see topshot_fmv_pct_stale_30d'::text AS text
        $arm$;

  v_new := substring(v_def for v_start - 1) || v_arm || substring(v_def from v_start + v_len);

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;

  v_def := pg_get_viewdef('public.v_rpc_trust_health'::regclass, true);

  IF position('CORRECTED 2026-08-08' in v_def) = 0 THEN
    RAISE EXCEPTION 'ABORT: corrected note absent after splice';
  END IF;
  IF position('99.5 AS "numeric"' in v_def) = 0 THEN
    RAISE EXCEPTION 'ABORT: breach_at 99.5 not found after splice';
  END IF;
  IF position('WHERE pre.metric = ''ufc_fmv_pct_stale_30d''::text' in v_def) = 0 THEN
    RAISE EXCEPTION 'ABORT: value expression lost after splice';
  END IF;

  v_u_after := (length(v_def) - length(replace(v_def, 'UNION ALL', ''))) / length('UNION ALL');
  IF v_u_after <> v_u_before THEN
    RAISE EXCEPTION 'ABORT: branch count changed % -> %, expected 1-for-1', v_u_before, v_u_after;
  END IF;

  RAISE NOTICE 'ok: ufc pct-stale note corrected; branches unchanged at %', v_u_after;
END
$mig$;

ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
