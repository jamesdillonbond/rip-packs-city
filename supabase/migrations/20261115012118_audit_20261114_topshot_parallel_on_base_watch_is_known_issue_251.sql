-- audit_20261114_topshot_parallel_on_base_watch_is_known_issue_251
--
-- WHAT: 20261115011709 shipped check_topshot_parallel_sales_on_base() and two watchlist rows
-- labelled "known-issue #250", but #250 was taken in docs/reference/known-issues.md by another
-- session (the trade room) while that change was pending. The alarm text points a reader at the
-- wrong issue, so relabel it #251. Body otherwise unchanged: the function is re-created from its
-- own live definition with the label swapped (it is not pinned; no test copy exists).
--
-- REVERT: same DO block with '#251' and '#250' swapped.

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('public.check_topshot_parallel_sales_on_base(integer)'::regprocedure) INTO v_def;
  IF position('known-issue #250' IN v_def) = 0 THEN
    RAISE EXCEPTION 'check_topshot_parallel_sales_on_base no longer carries the #250 label; re-read before relabelling';
  END IF;
  EXECUTE replace(v_def, 'known-issue #250', 'known-issue #251');
END $$;

UPDATE public.pipeline_cadence_watchlist
   SET notes = replace(notes, 'Known-issue #250.', 'Known-issue #251.')
 WHERE pipeline IN ('topshot-parallel-on-base-watch', 'topshot-parallel-sales-followup')
   AND notes LIKE '%Known-issue #250.%';
