-- audit_20261111_topshot_map_checkpoint_reconcile_correct_zero
--
-- 2026-11-11 ~11:25 AM PT (Claude Code cloud; Sentinel WARN 11:04 AM PT, Trevor: "Work through these too").
--
-- ZERO-YIELD: topshot-map-checkpoint-reconcile (93 runs, last find 2026-11-03) is a VERIFIER: it
-- sweeps the Top Shot moment map in 200k-nft slices against the chain MomentMinted checkpoint and
-- repoints any row that disagrees. A zero is its correct answer while the map is right (#226 closed
-- 11-05: 200/200 chain-verified sample). Positive control that the input is LIVE, read today:
-- extra.newest_record advanced 53,123,818 (11-08) -> 53,125,354 (11-09) -> 53,148,540 (11-10), and
-- extra.wrapped=true on every day 11-08..11-11 (a full pass per day), candidates 0 throughout.
-- The 11-11 overnight pass had already dispositioned it benign; this records that with a
-- re-check condition so the arm stops re-raising a correct zero.
--
-- REVERT:
--   DELETE FROM public.pipeline_zero_yield_suppressions WHERE pipeline = 'topshot-map-checkpoint-reconcile';

DO $mig$
DECLARE v_runs int; v_ok int; v_cands int; v_wrapped boolean; v_newest_min bigint; v_newest_max bigint;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE ok), coalesce(sum((extra->>'candidates')::int), 0),
         bool_or((extra->>'wrapped')::boolean),
         min((extra->>'newest_record')::bigint), max((extra->>'newest_record')::bigint)
    INTO v_runs, v_ok, v_cands, v_wrapped, v_newest_min, v_newest_max
    FROM public.pipeline_runs
   WHERE pipeline = 'topshot-map-checkpoint-reconcile' AND started_at > now() - interval '4 days';
  IF v_runs < 20 OR v_ok < v_runs THEN
    RAISE EXCEPTION 'premise false: % runs (% ok) in 4 d, expected ~36 all ok', v_runs, v_ok;
  END IF;
  IF v_cands <> 0 THEN
    RAISE EXCEPTION 'premise false: % candidates in 4 d — not a zero', v_cands;
  END IF;
  IF NOT coalesce(v_wrapped, false) OR v_newest_max <= v_newest_min THEN
    RAISE EXCEPTION 'premise false: sweep not wrapping (%) or checkpoint not advancing (% -> %)', v_wrapped, v_newest_min, v_newest_max;
  END IF;
END
$mig$;

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by) VALUES
('topshot-map-checkpoint-reconcile',
 'CORRECT ZERO, measured 2026-11-11 ~11:20 AM PT. A verifier: it sweeps the Top Shot moment map in 200k-nft slices against the chain MomentMinted checkpoint and repoints rows that disagree; 0 means the map agrees (#226 closed 11-05, 200/200 chain-verified sample). Positive control: extra.newest_record advanced 53,123,818 (11-08) -> 53,148,540 (11-10), so the checkpoint input is live, and extra.wrapped=true every day 11-08..11-11 (a full pass per day), candidates 0 throughout. Last find 11-03. RE-CHECK CONDITION: remove this row if extra.newest_record stops advancing for more than 3 days (the checkpoint feed died, so the zero would be blind), or if no run reports wrapped=true for more than 2 days (the sweep stuck).',
 'claude-code-cloud session_014vX7Q4R8WSRQJUo8TaMnUS')
ON CONFLICT (pipeline) DO UPDATE SET reason = EXCLUDED.reason, added_by = EXCLUDED.added_by;
