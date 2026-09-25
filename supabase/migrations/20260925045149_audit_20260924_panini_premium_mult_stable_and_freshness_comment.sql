-- audit_20260924_panini_premium_mult_stable_and_freshness_comment
-- Two follow-throughs from known-issues #136 (Panini FMV 1.1.0 session), no behaviour change today:
-- 1. panini_serial_premium_mult() was declared IMMUTABLE while it READS panini_serial_premium, a
--    tunable table refit on 2026-09-24 (20260925000244). IMMUTABLE lets the planner fold a call with
--    constant arguments at plan time, so a cached plan could keep serving the pre-refit multiplier.
--    STABLE is the honest volatility. Its only dependents are the views panini_deal_board and
--    panini_special_serials_board (no index expression uses it — checked pg_depend / pg_index).
--    Body byte-identical to 20260725010500; CREATE OR REPLACE preserves grants.
-- anon-exec: intentional — unchanged ACL, CREATE OR REPLACE of a pre-existing function; it returns only the three premium multipliers (panini_serial_premium_mult)
-- 2. panini_serial_freshness's COMMENT still said a walk re-reads ONE 30-row page. Since the
--    loadAllSerialPages() runner change (09-24) a walk pages the whole edition, so
--    max_serials_per_edition_walk above 30 is expected and editions_at_page_cap now counts editions
--    with >=30 serials refreshed in their latest walk (a size bucket, not a cap). Name kept so no
--    reader breaks; the comment carries the meaning.
-- Revert: re-run 20260725010500 (IMMUTABLE) and the COMMENT from 20260924035329.

CREATE OR REPLACE FUNCTION public.panini_serial_premium_mult(p_is_jersey boolean, p_is_perfect boolean, p_is_num1 boolean)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    case when p_is_jersey  then (select multiplier from public.panini_serial_premium where flag='jersey mint') end,
    case when p_is_perfect then (select multiplier from public.panini_serial_premium where flag='perfect mint') end,
    case when p_is_num1    then (select multiplier from public.panini_serial_premium where flag='number 1') end,
    1.00);
$function$;

COMMENT ON VIEW public.panini_serial_freshness IS
  'One-row SERIAL-grain freshness for Panini — the grain panini_coverage_summary (edition-grain) cannot '
  'see. Until 2026-09-24 a walk re-read ONE 30-row getPskuTotalCardsList page per edition, so '
  'max_serials_per_edition_walk pinned at 30 was the page cap''s signature. Since the runner''s '
  'loadAllSerialPages() (09-24) a walk pages the whole edition: values above 30 are expected, and '
  'editions_at_page_cap (name kept for readers) now just counts editions with >=30 serials refreshed in '
  'their latest walk. The live page-cap alarm is sentinel_panini_health().max_serials_per_edition_26h <= 30. '
  'Baseline 2026-09-23 ~20:45 PT: 16.8% of serials and 48% of serial asks unconfirmed in 7 days. '
  'Ops-only (service_role).';
