-- anon-exec: get_collection_stats(text) — SECURITY DEFINER, CREATE OR REPLACE of an identical
-- signature, so the ACL is preserved. Asserted before/after rather than assumed.
--
-- `/api/collection-stats` ran the SAME per-edition FMV lateral scan TWICE per request.
--
-- `get_collection_stats(text)` already walks every edition with one `fmv_snapshots` probe each to
-- compute `fmv_covered` (confidence <> 'NO_DATA'). The route then ran the BYTE-EQUIVALENT scan a
-- second time through `query_sql`, in a `Promise.all`, for a different FILTER
-- (confidence IN ('HIGH','MEDIUM')). Wall-clock hid it; the DB load is the SUM, and this instance is
-- IO-bound.
--
-- MEASURED 2026-09-02 ~05:2xZ, OUTSIDE the saturation band (this is the quiet-hours FLOOR):
--   get_collection_stats('nba_top_shot')  244,916 buffers cold / 244,754 WARM · 3,863 ms / 1,257 warm
--   get_collection_stats('nfl_all_day')    82,816 buffers · 3,265 ms
--   the route's SECOND pass, on its own   116,945 buffers (7,884 read) · 2,875 ms · 19,942 lateral loops
-- ⚠ The warm Top Shot call still touches 244,754 buffers — only the disk reads fall. This is NOT a
-- cache-warming problem and cannot be waited out.
--
-- THE FIX: fold the second aggregate into the pass the function ALREADY makes. Adding
-- `COUNT(*) FILTER (WHERE latest.confidence IN ('HIGH','MEDIUM'))` to the same SELECT costs
-- approximately nothing, and the route drops `computeHighMediumPct` entirely. Same numbers, same
-- freshness, ~117k buffers and ~2.9 s off every uncached request. No new object.
--
-- ⛔ THE TEMPTING ALTERNATIVE, NOT TAKEN: `rpc_trust_health_precompute` already publishes this metric
-- per collection (~3-hourly, and verified to be the SAME instrument — 39.9 vs the route's live 39.8 for
-- Top Shot). Reading it would take the second pass to one row, but it trades a live figure for one up
-- to ~3 h stale ON A USER-FACING ACCURACY CLAIM, and it carries only the percentage while the route
-- also returns `fmv_high_medium_count`. That is a product decision. Fold first.
--
-- ⛔ ALSO NOT DONE: bounding the probes by `computed_at`. Each probe descends three partitions and
-- `fmv_snapshots_2027` returns 0 rows on all 19,942 loops for ~39,884 buffers (~34% of the leg), but an
-- edition whose newest snapshot predates any bound would silently DROP OUT of the covered count — a
-- fabricated coverage number, which is the defect class this repo is trying to eliminate.
-- 👉 Transferable: the tax of a partitioned lateral scales with PARTITION COUNT. Adding a 2028
-- partition adds ~40k buffers to this call for nothing.
--
-- HOW IT IS PATCHED: surgically, via the technique
-- `20260815083710_audit_20260815_collection_stats_prune_future_fmv_partitions.sql` established here —
-- read `pg_get_functiondef`, ASSERT each anchor occurs EXACTLY ONCE, refuse if already patched,
-- `EXECUTE replace(...)`. The 12.5 KB body is never retyped, so a transcription slip cannot ship.
-- ⚠ The trap this guards: the Pinnacle branch's `INTO` list starts with the SAME two variables as the
-- non-Pinnacle one, so a bare prefix anchor would patch the wrong branch. Anchor 3 therefore carries
-- the preceding `NULLIF` line and the following `FROM editions e`.
--
-- REVERT: re-apply the pre-patch definition by inverting the four replacements (drop the two
-- `v_fmv_hm_*` declarations, the two added aggregates, and the two `fmv_high_medium_*` jsonb keys), and
-- restore `computeHighMediumPct` in app/api/collection-stats/route.ts.

DO $mig$
DECLARE
  v_def  text;
  v_new  text;
  v_n    int;
  v_anon_before boolean;
  v_svc_before  boolean;

  -- Each anchor is matched VERBATIM against pg_get_functiondef output. Nested dollar-quoting ($a$)
  -- keeps them readable — doubling every quote is how a surgical patch becomes a transcription bug.
  a1 text := $a$  v_fmv_covered INT;
  v_fmv_pct NUMERIC;$a$;
  n1 text := $a$  v_fmv_covered INT;
  v_fmv_pct NUMERIC;
  v_fmv_hm_covered INT;
  v_fmv_hm_pct NUMERIC;$a$;

  a2 text := $a$      NULL::numeric,
      MAX(fmv_computed_at)
    INTO v_fmv_covered, v_fmv_pct, v_fmv_age_minutes, v_fmv_last_at
    FROM pinnacle_catalog;$a$;
  n2 text := $a$      NULL::numeric,
      MAX(fmv_computed_at),
      COUNT(*) FILTER (WHERE fmv_confidence IN ('HIGH','MEDIUM')),
      ROUND(100.0 * COUNT(*) FILTER (WHERE fmv_confidence IN ('HIGH','MEDIUM'))
            / NULLIF(v_edition_count, 0), 1)
    INTO v_fmv_covered, v_fmv_pct, v_fmv_age_minutes, v_fmv_last_at,
         v_fmv_hm_covered, v_fmv_hm_pct
    FROM pinnacle_catalog;$a$;

  a3 text := $a$            / NULLIF(v_edition_count, 0), 1)
    INTO v_fmv_covered, v_fmv_pct
    FROM editions e$a$;
  n3 text := $a$            / NULLIF(v_edition_count, 0), 1),
      COUNT(*) FILTER (WHERE latest.confidence IN ('HIGH','MEDIUM')),
      ROUND(100.0 * COUNT(*) FILTER (WHERE latest.confidence IN ('HIGH','MEDIUM'))
            / NULLIF(v_edition_count, 0), 1)
    INTO v_fmv_covered, v_fmv_pct, v_fmv_hm_covered, v_fmv_hm_pct
    FROM editions e$a$;

  a4 text := $a$    'fmv_pct', v_fmv_pct,$a$;
  n4 text := $a$    'fmv_pct', v_fmv_pct,
    'fmv_high_medium_count', v_fmv_hm_covered,
    'fmv_high_medium_pct', v_fmv_hm_pct,$a$;
BEGIN
  v_anon_before := has_function_privilege('anon', 'public.get_collection_stats(text)', 'EXECUTE');
  v_svc_before  := has_function_privilege('service_role', 'public.get_collection_stats(text)', 'EXECUTE');

  v_def := pg_get_functiondef('public.get_collection_stats(text)'::regprocedure);

  IF position('fmv_high_medium_pct' in v_def) > 0 THEN
    RAISE EXCEPTION 'ALREADY PATCHED: get_collection_stats(text) already emits fmv_high_medium_pct';
  END IF;

  v_new := v_def;

  -- ⚠ ASSERT THE OCCURRENCE COUNT BEFORE EVERY REPLACE. A silent no-op replace yields a "patched"
  -- function byte-identical to the original, and the result reads as a successful migration.
  v_n := (length(v_new) - length(replace(v_new, a1, ''))) / length(a1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 1 (DECLARE) matched % times, expected 1', v_n; END IF;
  v_new := replace(v_new, a1, n1);

  v_n := (length(v_new) - length(replace(v_new, a2, ''))) / length(a2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 2 (pinnacle branch) matched % times, expected 1', v_n; END IF;
  v_new := replace(v_new, a2, n2);

  v_n := (length(v_new) - length(replace(v_new, a3, ''))) / length(a3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 3 (non-pinnacle branch) matched % times, expected 1', v_n; END IF;
  v_new := replace(v_new, a3, n3);

  v_n := (length(v_new) - length(replace(v_new, a4, ''))) / length(a4);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 4 (RETURN) matched % times, expected 1', v_n; END IF;
  v_new := replace(v_new, a4, n4);

  EXECUTE v_new;

  IF has_function_privilege('anon', 'public.get_collection_stats(text)', 'EXECUTE') <> v_anon_before THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon EXECUTE changed';
  END IF;
  IF has_function_privilege('service_role', 'public.get_collection_stats(text)', 'EXECUTE') <> v_svc_before THEN
    RAISE EXCEPTION 'POST-STATE FAILED: service_role EXECUTE changed';
  END IF;
END
$mig$;

-- ── EQUIVALENCE, PROVED RATHER THAN ARGUED ─────────────────────────────────────────────────────────
-- The claim is that the folded aggregate returns EXACTLY what the route's second pass returned. A plan
-- comparison would only show it is cheaper. So: call the patched function and the route's original
-- query IN THE SAME STATEMENT — one snapshot, so a concurrent fmv-recalc write cannot make an
-- equivalent pair look different — and compare.
DO $post$
DECLARE
  r record;
  v_seen int := 0;
BEGIN
  FOR r IN
    SELECT c.slug,
           (s.j->>'fmv_high_medium_count')::int     AS fn_hm,
           (s.j->>'fmv_high_medium_pct')::numeric   AS fn_pct,
           (s.j->>'edition_count')::int             AS fn_total,
           (SELECT count(*) FROM editions e
              CROSS JOIN LATERAL (
                SELECT fs.confidence FROM fmv_snapshots fs
                WHERE fs.collection_id = c.id AND fs.edition_id = e.id
                ORDER BY fs.computed_at DESC LIMIT 1
              ) l
            WHERE e.collection_id = c.id AND l.confidence IN ('HIGH','MEDIUM')) AS ctl_hm,
           (SELECT count(*) FROM editions e WHERE e.collection_id = c.id) AS ctl_total
    FROM collections c
    CROSS JOIN LATERAL (SELECT public.get_collection_stats(c.slug) AS j) s
    WHERE c.slug IN ('nba_top_shot','nfl_all_day','laliga_golazos','ufc_strike')
  LOOP
    v_seen := v_seen + 1;
    IF r.fn_hm IS DISTINCT FROM r.ctl_hm THEN
      RAISE EXCEPTION 'POST-STATE FAILED: % folded HIGH/MEDIUM count % <> control %', r.slug, r.fn_hm, r.ctl_hm;
    END IF;
    IF r.fn_total IS DISTINCT FROM r.ctl_total THEN
      RAISE EXCEPTION 'POST-STATE FAILED: % edition_count % <> control %', r.slug, r.fn_total, r.ctl_total;
    END IF;
    IF r.fn_pct IS DISTINCT FROM round(100.0 * r.ctl_hm / NULLIF(r.ctl_total, 0), 1) THEN
      RAISE EXCEPTION 'POST-STATE FAILED: % pct % <> control %', r.slug, r.fn_pct,
        round(100.0 * r.ctl_hm / NULLIF(r.ctl_total, 0), 1);
    END IF;
    RAISE NOTICE 'equivalence ok: % — % of % HIGH/MEDIUM = % pct', r.slug, r.fn_hm, r.fn_total, r.fn_pct;
  END LOOP;

  -- ⚠ A loop that ran zero times passes every assertion inside it. Assert the population.
  IF v_seen <> 4 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 4 non-Pinnacle collections, checked %', v_seen;
  END IF;

  -- Pinnacle takes the render-grain branch, so it needs its own control.
  SELECT (s.j->>'fmv_high_medium_count')::int AS fn_hm,
         (s.j->>'fmv_high_medium_pct')::numeric AS fn_pct,
         (SELECT count(*) FROM pinnacle_catalog WHERE fmv_confidence IN ('HIGH','MEDIUM')) AS ctl_hm,
         (SELECT count(*) FROM pinnacle_catalog) AS ctl_total
  INTO r
  FROM (SELECT public.get_collection_stats('disney_pinnacle') AS j) s;

  IF r.fn_hm IS DISTINCT FROM r.ctl_hm THEN
    RAISE EXCEPTION 'POST-STATE FAILED: pinnacle folded HIGH/MEDIUM count % <> control %', r.fn_hm, r.ctl_hm;
  END IF;
  IF r.fn_pct IS DISTINCT FROM round(100.0 * r.ctl_hm / NULLIF(r.ctl_total, 0), 1) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: pinnacle pct % <> control', r.fn_pct;
  END IF;
  RAISE NOTICE 'equivalence ok: disney_pinnacle — % of % HIGH/MEDIUM = % pct', r.fn_hm, r.ctl_total, r.fn_pct;
END
$post$;