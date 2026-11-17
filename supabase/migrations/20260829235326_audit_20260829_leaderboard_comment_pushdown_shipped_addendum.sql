-- audit_20260829_leaderboard_comment_pushdown_shipped_addendum
-- Metadata only. APPENDS a dated section to the comment on public.analytics_sales_leaderboard(...)
-- (installed 20260829090940, extended 20260829171156). The existing text ends on "STILL CLOSED, do not revive:
-- ... the prior_addrs correlated-EXISTS rewrite (measured and refuted)" -- which is now the SHIPPED shape
-- (20260829234203), so the last word must not send the next pass to revert it.
-- Guard: asserts the comment carries the 171156 anchor and does not already carry this addendum.
-- REVERT: truncate the comment back to the position of the addendum marker:
--   DO $r$ DECLARE c text; i int; BEGIN
--     c := obj_description('public.analytics_sales_leaderboard(text,timestamptz,timestamptz,text[],integer,numeric,boolean)'::regprocedure,'pg_proc');
--     i := position('=== 2026-08-29 23:5xZ' in c);
--     EXECUTE format('COMMENT ON FUNCTION public.analytics_sales_leaderboard(text,timestamptz,timestamptz,text[],integer,numeric,boolean) IS %L', left(c, i-3));
--   END $r$;
DO $mig$
DECLARE
  v_sig text := 'public.analytics_sales_leaderboard(text,timestamptz,timestamptz,text[],integer,numeric,boolean)';
  v_old text; v_new text; v_read text;
BEGIN
  SET LOCAL lock_timeout = '5s';
  v_old := obj_description(v_sig::regprocedure::oid, 'pg_proc');
  IF v_old IS NULL OR position('A SECOND TEN-WIDE SWEEP FAILED 10 OF 10' in v_old) = 0 THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: the 20260829171156 section is not present (len %)', coalesce(length(v_old),0);
  END IF;
  IF position('THE PUSH-DOWN SHIPPED' in v_old) > 0 THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: addendum already present';
  END IF;
  v_new := v_old || '

=== 2026-08-29 23:5xZ (16:5x PT) -- THE PUSH-DOWN SHIPPED, AND THE "DO NOT REVIVE" LINE ABOVE IS SUPERSEDED FOR THE EXISTS REWRITE ===
(Cowork desktop-VM pass with git.) Migration 20260829234203 rewrote this function to read the base tables directly:
short-form names map back to long-form sales.collection so idx_sales_2026_pulse_window serves the window as an
Index Only Scan; pinnacle stays on pinnacle_sales; unmapped names (candy_mlb) pass through like the view''s ELSE.
is_returning is now <= p_limit EXISTS probes on the address indexes. Same signature, ACLs unchanged.
MEASURED (buffers are the durable figure): ufc l30 41,361 -> 2,194 (25.8 s -> 59 ms); topshot l30 162,717 + 6,665 temp
-> 27,642 (43.6 s -> 11.6 s). Result equality proven by EXCEPT in both directions on three parameter sets.
REFUTED ON THE WAY: pushing collection_id alongside the text predicate makes the planner choose the non-covering
collection_id index (86k buffers on topshot). The TEXT predicate alone is the one that reaches the covering index.
STILL OPEN: (1) the NULL-collections (all) call reads ~95k buffers / ~30 s and is NOT on the sweep path; (2) the
topshot call still carries ~16.8k heap fetches from sales_2026''s visibility map -- jobid 383 (re-own of 380 to
cron_heavy, 53 10,20 * * *) is the hygiene half. Materialising this leaderboard stays CLOSED (Trevor, explicit).
The EXISTS rewrite is no longer "refuted" -- the 08-28 measurement took it while the agg leg read the whole window
through the view; with the push-down its cost is <= 10 index probes.';
  EXECUTE format('COMMENT ON FUNCTION %s IS %L', v_sig, v_new);
  v_read := obj_description(v_sig::regprocedure::oid, 'pg_proc');
  IF v_read IS NULL OR left(v_read, length(v_old)) <> v_old OR position('THE PUSH-DOWN SHIPPED' in v_read) = 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED';
  END IF;
END
$mig$;