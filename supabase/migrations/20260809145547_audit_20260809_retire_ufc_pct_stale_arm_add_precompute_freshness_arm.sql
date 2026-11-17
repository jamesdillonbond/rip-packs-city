-- 2026-08-09 — v_rpc_trust_health: retire the UFC dated-fuse arm, add a precompute-freshness arm.
--
-- Applied to prod via Supabase MCP as migration 20260809145547 (Cowork cannot push; this file
-- is the repo record — commit it to close the prod/repo drift window).
--
-- WHY (1) RETIRE `ufc_fmv_pct_stale_30d`:
--   Measured 2026-08-08 over all 465 UFC editions holding a latest snapshot: max FMV age
--   67.79d, median 67.77d, 447/465 already past 30d — the 96.1 reading. The UFC FMV writer
--   switched itself off 2026-08-03 (final write 2026-08-04 06:31:44Z), and Flow UFC trading
--   has been dead since 2026-05-13 (Aptos migration), so the 18 editions still under the
--   line age a day per day and the metric reaches 100.0 on 2026-09-03 06:31:44Z >= 99.5.
--   A percentage cannot exceed 100, so there is NO threshold remedy: it becomes a PERMANENT
--   red, and a permanently-red arm trains the operator to skim past all 38. Revival is
--   already covered by `ufc_flow_revival_sales_30d` (installed 2026-08-08, breach_at 1,
--   keyed on sold_at). Retire, never re-threshold.
--
-- WHY (2) ADD `trust_precompute_max_age_hours`:
--   `rpc-trust-health-precompute-refresh` (pg_cron jobid 222, `58 */6 * * *`) FAILED at
--   2026-08-09 12:58Z after exactly 600.001s — its own proconfig statement_timeout. The fn
--   is single-transaction and Leg 7 (sales_serial_supply_worst_pct) carries no handler, so the
--   kill rolled back ALL 18 metrics; the table still carried 06:58Z values 8 hours later.
--   Runtime is wildly contention-dependent (59s and 71s on the two quiet ticks, 536s and 569s
--   on the 08-08 contended ticks, then 600s+).
--   Nothing watched this. The view's `pre` CTE maps any row older than 24h to 999, so three
--   consecutive misses do not present as "the precompute is down" — they present as a cluster
--   of ~13 unrelated red arms, hours after the fact. This arm converts that silent,
--   misattributed failure into one correctly-named red arm, earlier.
--
--   breach_at 13h is placed deliberately: max legitimate age just before a tick is ~6h plus
--   the previous run's duration (<=10 min) = ~6.2h, so ONE missed cycle (~12.2h) does NOT
--   fire — no flapping on a single contended miss — while TWO missed cycles (~18.2h) do,
--   ahead of the 24h auto-999 cliff. Cost is an 18-row seq scan on a table the `pre` CTE
--   already reads; it adds nothing measurable to a board read.
--
-- DELIBERATELY NOT DONE — this is a ONE-part change, correcting the "two-part" note in the
--   2026-08-08 finding. That note said retiring the arm must also strip the metric from
--   `rpc_trust_health_precompute_refresh()` or it "leaves an orphaned precompute row still
--   refreshing against a saturated instance". Re-measured: the UFC metric is a single row of
--   the `want` VALUES list LEFT JOINed to the `agg` CTE that Legs 2-5 compute anyway, so its
--   marginal cost is ZERO — there is no saturation saving to bank, and redefining a 13KB
--   load-bearing plpgsql function by prosrc splice while the instance is contended is real
--   risk for no gain. It is reclassified TRACK-only, exactly like the 5 existing
--   `{coll}_fmv_high_med_share_pct` metrics. It must KEEP refreshing: the new freshness arm
--   reads max(age) across ALL rows, so deleting or freezing the row would peg that arm red
--   forever.
--
-- METHOD: the view is the platform's primary trust board with 38 inline arms and CANNOT be
--   retyped. A DO block reads pg_get_viewdef(), applies anchored edits that each RAISE on
--   no-match, asserts the arm count and both anchors after, and feeds the result back through
--   CREATE OR REPLACE VIEW. Assertions key on the ARM ANCHOR, never a bare substring: the
--   string 'ufc_fmv_pct_stale_30d' legitimately survives inside the topshot arm's note text.
--
-- VERIFIED AFTER: 38 arms (-1 +1), UFC pct-stale arm anchor absent, revival arm intact,
--   reloptions {security_invoker=on}, anon SELECT false, check_public_security_invariants() 0,
--   and the new arm read live through the view at 7.97 / breach 13 / ok. Reading the board
--   filtered by `metric IN (...)` returns instantly — Postgres prunes the UNION ALL branches
--   on the constant, so single arms ARE cheaply readable even though the whole board is not.
--
-- REVERT: re-apply migration 20260808163950's committed view definition, or re-insert the
--   removed arm block with breach_at 99.5 and delete the new arm block; then
--   ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);

DO $mig$
DECLARE
  v_def          text;
  v_new          text;
  v_ufc_anchor   text := E'        UNION ALL\n         SELECT ''ufc_fmv_pct_stale_30d''::text AS text,';
  v_next_anchor  text := E'        UNION ALL\n         SELECT ''';
  v_rev_anchor   text := E'        UNION ALL\n         SELECT ''ufc_flow_revival_sales_30d''::text AS text,';
  v_new_arm      text;
  v_start        int;
  v_rel          int;
  v_arms_before  int;
  v_arms_after   int;
BEGIN
  v_def := pg_get_viewdef('public.v_rpc_trust_health'::regclass, true);

  SELECT count(*) INTO v_arms_before
    FROM regexp_matches(v_def, 'SELECT ''([a-z0-9_]+)''::text AS ', 'g');
  IF v_arms_before <> 38 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected 38 arms, found %', v_arms_before;
  END IF;

  IF position('trust_precompute_max_age_hours' in v_def) > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trust_precompute_max_age_hours already present';
  END IF;

  -- ---- edit 1: excise the UFC pct-stale arm block ----
  v_start := position(v_ufc_anchor in v_def);
  IF v_start = 0 THEN
    RAISE EXCEPTION 'ANCHOR NOT FOUND: ufc_fmv_pct_stale_30d arm block';
  END IF;
  v_rel := position(v_next_anchor in substring(v_def from v_start + length(v_ufc_anchor)));
  IF v_rel = 0 THEN
    RAISE EXCEPTION 'ANCHOR NOT FOUND: arm block following ufc_fmv_pct_stale_30d';
  END IF;
  v_new := substring(v_def from 1 for v_start - 1)
        || substring(v_def from v_start + length(v_ufc_anchor) + v_rel - 1);

  -- ---- edit 2: insert the precompute-freshness arm ahead of the UFC revival arm ----
  v_new_arm :=
E'        UNION ALL
         SELECT ''trust_precompute_max_age_hours''::text AS metric,
            COALESCE(( SELECT round(max(EXTRACT(epoch FROM now() - p2.computed_at))::numeric / 3600.0, 2)
                   FROM rpc_trust_health_precompute p2), 999::numeric) AS value,
            13::numeric AS breach_at,
            ''INSTRUMENT arm (installed 2026-08-09): oldest row in rpc_trust_health_precompute, in hours. Watches the WATCHER. rpc-trust-health-precompute-refresh (pg_cron jobid 222, 58 */6 * * *) is single-transaction and Leg 7 carries no handler, so ONE statement_timeout kill rolls back all 18 metrics and the table keeps its previous values silently — that is exactly what happened at 2026-08-09 12:58Z, killed at 600.001s against the fn proconfig statement_timeout of 600s, after quiet-tick runs of 59s and 71s and contended runs of 536s and 569s. Without this arm the failure is invisible until the pre CTE 24h cutoff maps every stored row to 999, which reddens ~13 unrelated precomputed arms at once and reads as a platform-wide collapse rather than as one dead refresher. breach_at 13 is placed so that ONE missed cycle cannot fire (max legitimate age is ~6h cadence plus up to a 10min run = ~6.2h, so one miss is ~12.2h) while TWO missed cycles do (~18.2h), ~6h ahead of the 24h auto-999 cliff. Do NOT raise it to 24 or above: at 24 it can never fire before the thing it is meant to pre-empt, and any precomputed arm whose breach_at exceeds 999 goes blind on refresher death instead of loud.''::text AS catches
';

  v_start := position(v_rev_anchor in v_new);
  IF v_start = 0 THEN
    RAISE EXCEPTION 'ANCHOR NOT FOUND: ufc_flow_revival_sales_30d arm block (insertion point)';
  END IF;
  v_new := substring(v_new from 1 for v_start - 1) || v_new_arm || substring(v_new from v_start);

  -- ---- post-conditions on the TEXT, before we commit it ----
  SELECT count(*) INTO v_arms_after
    FROM regexp_matches(v_new, 'SELECT ''([a-z0-9_]+)''::text AS ', 'g');
  IF v_arms_after <> 38 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 38 arms after (-1 +1), found %', v_arms_after;
  END IF;
  IF position(v_ufc_anchor in v_new) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: ufc_fmv_pct_stale_30d arm anchor still present';
  END IF;
  IF position(E'SELECT ''trust_precompute_max_age_hours''::text AS ' in v_new) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: new arm anchor absent';
  END IF;
  IF position(v_rev_anchor in v_new) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: ufc_flow_revival_sales_30d arm lost';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
END
$mig$;

-- CREATE OR REPLACE VIEW wipes reloptions — re-assert (bitten 2026-08-03 on this exact view).
ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
