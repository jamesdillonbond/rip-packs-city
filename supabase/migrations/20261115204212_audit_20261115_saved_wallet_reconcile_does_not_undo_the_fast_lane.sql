-- audit_20261115_saved_wallet_reconcile_does_not_undo_the_fast_lane
--
-- Claude Code cloud, 2026-11-15 ~1:00 PM PT (#248; Trevor: "Do what you think is best").
--
-- DEFECT: reconcile_wmc_fmv_for_wallet (job 446 via reconcile_saved_wallets_wmc_fmv, `6,36 * * * *`)
-- copies edition_fmv_current into a saved wallet's wmc rows. edition_fmv_current lags the newest
-- snapshot by up to ~2 h (refreshes at :59; 92:3818's 9:08 AM PT snapshot landed there at 10:59), while
-- refresh_wmc_fmv_changed pushes the newest snapshot ~5 min after it is written. So between the two,
-- this function wrote the OLD price back over the lane's new one — and rwfc_applied (20261114171317)
-- then told the lane there was nothing left to do. Evidence 11-15: on 51:1946 the 19 stale rows had an
-- xmin later than the lane's 8:13 AM PT write, all 10 wallets saved wallets reconciled at 8:36 AM PT.
-- These were most of the fast lane's residual 0.15 % misses.
--
-- CHANGE: skip an edition the lane applied AFTER edition_fmv_current last refreshed, when the two
-- disagree — the lane's value is the newer one. One PK probe on rwfc_applied per edition. If the lane
-- ever stops writing rwfc_applied, applied_at falls behind refreshed_at within an hour and the clause
-- goes inert, so this cannot freeze a row. 81 of 69,003 applied editions matched at 12:55 PM PT.
--
-- Revert: re-apply the reconcile_wmc_fmv_for_wallet body from
-- supabase/migrations/20260926004446_audit_20260925_saved_wallet_fmv_reconcile_stops_folding_base58.sql.
-- anon-exec: reconcile_wmc_fmv_for_wallet — unchanged; CREATE OR REPLACE preserves the ACL.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_wmc_fmv_for_wallet(text)'::regprocedure)
     IS DISTINCT FROM '9a232eb6dcbacc5c93f15844782cd34f' THEN
    RAISE EXCEPTION 'reconcile_wmc_fmv_for_wallet changed since this migration was written — re-read the live body';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.reconcile_wmc_fmv_for_wallet(p_wallet text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_n integer;
BEGIN
  WITH fixed AS (
    UPDATE public.wallet_moments_cache w
       SET fmv_usd        = l.fmv_usd,
           fmv_confidence = l.confidence
      FROM public.editions e
      JOIN public.edition_fmv_current l ON l.edition_id = e.id
     WHERE w.wallet_address = CASE WHEN p_wallet ~* '^0x' THEN lower(p_wallet) ELSE p_wallet END
       AND w.edition_key IS NOT NULL
       AND e.external_id   = w.edition_key
       AND e.collection_id = w.collection_id
       AND l.fmv_usd IS NOT NULL
       AND (w.fmv_usd IS DISTINCT FROM l.fmv_usd OR w.fmv_confidence IS DISTINCT FROM l.confidence)
       -- 2026-11-15 (#248): edition_fmv_current lags the newest snapshot by up to ~2 h; the fast lane
       -- does not. Never write its older value over one the lane pushed after it last refreshed.
       AND NOT EXISTS (
         SELECT 1 FROM public.rwfc_applied a
          WHERE a.edition_id = l.edition_id
            AND a.applied_at > l.refreshed_at
            AND (a.fmv_usd IS DISTINCT FROM l.fmv_usd OR a.confidence IS DISTINCT FROM l.confidence)
       )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM fixed;
  RETURN COALESCE(v_n, 0);
END
$function$;
