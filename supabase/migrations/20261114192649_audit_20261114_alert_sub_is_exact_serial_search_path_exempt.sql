-- 2026-11-14 (Claude Code cloud, ~11:26 AM PT) — inbox 2026-11-14T1905Z.
--
-- alert_sub_is_exact_serial(integer,integer,uuid[]) (created 20261114171316) shipped
-- without a search_path pin, so check_function_search_path_drift() reported it.
-- It is an IMMUTABLE SQL helper inlined per candidate row into the deal-alert
-- dispatcher; its body names NO relation (parameter comparisons + one uuid
-- literal), so the caller's search_path cannot change its result, and a SET
-- clause would only stop inlining. Take the 20261026001400 exemption path: a
-- named claim in the comment, valid only while anon/authenticated cannot
-- EXECUTE (asserted below). Live read before apply: anon false, authenticated false.
--
-- Revert: COMMENT ON FUNCTION public.alert_sub_is_exact_serial(integer, integer, uuid[]) IS NULL;
-- (the drift check then reports it again).

COMMENT ON FUNCTION public.alert_sub_is_exact_serial(integer, integer, uuid[]) IS
'search_path-exempt (inlined SQL helper): per-row inside dispatch_due_deal_alerts, build_deal_alerts_for_subscription and topshot_exact_serial_alert_deals; IMMUTABLE, body names NO relation (parameter comparisons + one uuid literal), so the caller''s search_path cannot change its result; EXECUTE revoked from PUBLIC/anon/authenticated. A SET search_path clause would only stop inlining. Do NOT ALTER ... SET search_path (20261026001400). True for a narrow serial window (1-10 serials) on a subscription that includes Top Shot (20261114171316).';
DO $$
BEGIN
  IF has_function_privilege('anon','public.alert_sub_is_exact_serial(integer,integer,uuid[])','EXECUTE')
     OR has_function_privilege('authenticated','public.alert_sub_is_exact_serial(integer,integer,uuid[])','EXECUTE') THEN
    RAISE EXCEPTION 'exemption requires anon/authenticated EXECUTE revoked';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.check_function_search_path_drift()) e
             WHERE e->>'object_name' = 'alert_sub_is_exact_serial(integer,integer,uuid[])') THEN
    RAISE EXCEPTION 'still reported by check_function_search_path_drift';
  END IF;
END $$;
