# Handoff 2026-06-09 — remaining cleanups (code + ledger; Cowork can't push these)

Small tail items from the 2026-06-08/09 Pinnacle + security work. None urgent. The DB-side items Cowork could do are already shipped (below); the rest are route/.tsx/ledger edits in CC's lane.

## Already shipped by Cowork (2026-06-09) — need ledger Shipped-block entries

1. `audit_20260609_drop_orphaned_pinnacle_fmv_recalc` — dropped the orphaned legacy edition-keyed pricer `pinnacle_fmv_recalc(text)` (0 DB callers, 0 code refs, not SECDEF; its only caller `pinnacle_fmv_recalc_all` was dropped in the 06-08 retirement). Final cleanup of PIN-FMV-REKEY. **Revert** = re-run this exact body:

CREATE OR REPLACE FUNCTION public.pinnacle_fmv_recalc(p_edition_id text)
 RETURNS json LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result json; v_wap numeric; v_wap_no_outliers numeric; v_sales_7d int; v_sales_30d int; v_days_since int; v_confidence text; v_liquidity int;
BEGIN
  SELECT ROUND(SUM(sale_price_usd * weight) / NULLIF(SUM(weight), 0), 4),
    COUNT(*) FILTER (WHERE sold_at > NOW() - interval '7 days'),
    COUNT(*) FILTER (WHERE sold_at > NOW() - interval '30 days'),
    EXTRACT(DAY FROM NOW() - MAX(sold_at))::int
  INTO v_wap, v_sales_7d, v_sales_30d, v_days_since
  FROM (SELECT sale_price_usd, sold_at, EXP(-0.03 * EXTRACT(DAY FROM NOW() - sold_at)) as weight
    FROM pinnacle_sales WHERE edition_id = p_edition_id AND sold_at > NOW() - interval '90 days' AND sale_price_usd > 0) weighted;
  IF v_wap IS NOT NULL AND v_wap > 0 THEN
    SELECT ROUND(SUM(sale_price_usd * weight) / NULLIF(SUM(weight), 0), 4) INTO v_wap_no_outliers
    FROM (SELECT sale_price_usd, EXP(-0.03 * EXTRACT(DAY FROM NOW() - sold_at)) as weight
      FROM pinnacle_sales WHERE edition_id = p_edition_id AND sold_at > NOW() - interval '90 days' AND sale_price_usd > 0
        AND sale_price_usd BETWEEN v_wap * 0.33 AND v_wap * 3.0) filtered;
  END IF;
  v_confidence := CASE WHEN v_sales_30d >= 5 AND v_days_since <= 14 THEN 'HIGH' WHEN v_sales_30d >= 2 AND v_days_since <= 30 THEN 'MEDIUM' WHEN v_sales_30d >= 1 THEN 'LOW' ELSE 'NO_DATA' END;
  v_liquidity := CASE WHEN v_sales_30d >= 20 THEN 5 WHEN v_sales_30d >= 10 THEN 4 WHEN v_sales_30d >= 5 THEN 3 WHEN v_sales_30d >= 2 THEN 2 WHEN v_sales_30d >= 1 THEN 1 ELSE 0 END;
  result := json_build_object('edition_id', p_edition_id, 'fmv_usd', COALESCE(v_wap_no_outliers, v_wap), 'wap_usd', v_wap, 'wap_without_outliers', v_wap_no_outliers, 'confidence', v_confidence, 'liquidity_rating', v_liquidity, 'sales_count_7d', COALESCE(v_sales_7d, 0), 'sales_count_30d', COALESCE(v_sales_30d, 0), 'days_since_sale', v_days_since, 'computed_at', NOW());
  RETURN result;
END; $function$;

2. `audit_20260609_lock_pinnacle_backup_and_rewards_tier_search_path` — locked the pre-drop backup `pinnacle_fmv_snapshots_backup_20260608` (it shipped RLS-off + anon/auth write = a live anon hole + the `rls_disabled_in_public` advisor ERROR): `ENABLE ROW LEVEL SECURITY` + `REVOKE ALL ... FROM anon, authenticated`; plus `ALTER FUNCTION rewards_tier(integer) SET search_path` (cleared the lone `function_search_path_mutable` lint). **Revert**: `ALTER TABLE public.pinnacle_fmv_snapshots_backup_20260608 DISABLE ROW LEVEL SECURITY; GRANT INSERT,UPDATE,DELETE,TRUNCATE,SELECT ON public.pinnacle_fmv_snapshots_backup_20260608 TO anon,authenticated; ALTER FUNCTION public.rewards_tier(integer) RESET search_path;`

3. `audit_20260609_trust_health_pinnacle_ask_freshness` — added `pinnacle_ask_stale_hours` metric to `v_rpc_trust_health` (BREACH at 3h since newest `ask_source='pinnacle_direct'` ask update; COALESCE→999 so a total wipe also breaches). The daily `rpc-trust-health-watch` now catches a Pinnacle ASK-writer stall (the silent-degradation class that hid the dead-Flowty floor). **Revert**: re-CREATE the view without the `pinnacle_ask_stale_hours` UNION ALL row (security_invoker=on; the body is captured in the migration).

## CC code items (route/.tsx — Cowork can't push)

4. **Delete `app/api/pinnacle-listing-cache/route.ts`.** It's an inert auth-gated no-op since `04011b3`, and its cron-job.org schedule was deleted 2026-06-09 (verified gone from the dashboard). Pure dead weight now — safe to remove the file. (Confirm nothing else imports it — it's a route handler, so it shouldn't be imported anywhere.)

5. **Tidy the stale `drain-fmv-cold-tail` comment.** `app/api/admin/drain-fmv-cold-tail/route.ts` ~L10 says "Pinnacle is intentionally excluded — it has its own hourly chain via `pinnacle_fmv_recalc_all`." That fn was dropped in the 06-08 retirement (and `pinnacle_fmv_recalc(text)` above). Update to reference the per-render engine (`pinnacle_fmv_recalc_render_all` via pinnacle-sync). Comment-only.

6. **Brand-token Phase-2 (~70 files, tracked debt, NOT gated).** The Phase-1 sweep + CI guard (`scripts/check-brand-tokens.mjs`) shipped 06-08 (`de01542`) covering the 6 public surfaces; the guard header documents the ~70-file Phase-2 backlog (admin, dashboard, modals, email HTML). Mechanical: replace hardcoded `#E03A2F` / `'Barlow Condensed'` / `'Share Tech Mono'` with `var(--rpc-red)` / `var(--font-display)` / `var(--font-mono)`, keeping the documented OG/email/Console exceptions. Low-risk, do in batches; extend the CI guard's allowlist as each surface is cleaned. Not urgent.

## Not actionable yet (blocked / automatic)
- HybridCustody linked-path e2e test — needs a real HybridCustody-linked registered user (none in the data; the logic is verified). Just needs its first real user.
- The ~10:07Z `pinnacle-sync` daily tick is the automatic final confirmation of the FMV retirement.

GUARDRAILS: direct-to-main, no branches/PRs; ledger-log the 3 migrations above. CC's file inspection wins over this doc.
