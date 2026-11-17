-- 2026-10-03 (Trevor: "fix anything still unresolved"): /admin/feedback read
-- "TOTAL OPEN 2 · OPEN BUGS 1 · OPEN FEATURES 1" over an EMPTY "All open" list.
-- The list (app/api/admin/feedback/route.ts) excludes is_smoke_test rows
-- (2026-10-03 AM); the stat tiles read beta_feedback_stats, which did not.
-- The two "open" rows were QA probe sessions 10367 / 10373. A count and the
-- list it summarises must come from the SAME population — same WHERE here.
-- security_invoker re-asserted (CREATE OR REPLACE VIEW resets reloptions);
-- column list unchanged (a view cannot rename/reorder columns in place).
-- Revert: re-create the view without the is_smoke_test predicate.

CREATE OR REPLACE VIEW public.beta_feedback_stats
WITH (security_invoker = on) AS
 SELECT feedback_type,
    feedback_status,
    count(*)::integer AS n,
    max(created_at) AS most_recent,
    bool_or(feedback_status = 'shipped'::text AND shipped_at > (now() - '7 days'::interval)) AS shipped_last_7d
   FROM support_conversations
  WHERE feedback_type IS NOT NULL
    AND is_smoke_test = false
  GROUP BY feedback_type, feedback_status;

DO $verify$
DECLARE
  v_opts text[];
  v_stats_new int;
  v_list_new int;
BEGIN
  SELECT reloptions INTO v_opts FROM pg_class WHERE relname = 'beta_feedback_stats';
  IF NOT ('security_invoker=on' = ANY (v_opts)) THEN
    RAISE EXCEPTION 'beta_feedback_stats lost security_invoker';
  END IF;
  SELECT coalesce(sum(n), 0) INTO v_stats_new FROM public.beta_feedback_stats WHERE feedback_status = 'new';
  SELECT count(*) INTO v_list_new FROM public.support_conversations
   WHERE feedback_type IS NOT NULL AND is_smoke_test = false AND feedback_status = 'new';
  IF v_stats_new <> v_list_new THEN
    RAISE EXCEPTION 'stats (%) and list (%) disagree on new rows', v_stats_new, v_list_new;
  END IF;
END
$verify$;
