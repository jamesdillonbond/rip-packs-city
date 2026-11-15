-- DB invariant: public.reconcile_wmc_fmv_for_wallet — job 446's per-wallet copy of
-- edition_fmv_current into a saved wallet's wallet_moments_cache rows.
--
-- WHY IT MATTERS (#248, 2026-11-15). edition_fmv_current refreshes at :59 and lags the newest
-- snapshot by up to ~2 h; refresh_wmc_fmv_changed pushes the newest snapshot ~5 min after it
-- lands and records it in rwfc_applied. Without the NOT EXISTS clause this function wrote the
-- OLDER price back over the lane's newer one, and rwfc_applied then told the lane there was
-- nothing left to do — most of the lane's residual misses on 11-15.
--
-- The function DDL below is VERBATIM from
-- supabase/migrations/20261115204212_audit_20261115_saved_wallet_reconcile_does_not_undo_the_fast_lane.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TYPE public.fmv_confidence AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'ASK_ONLY', 'SALES_ONLY', 'STALE', 'NO_DATA');

CREATE TABLE public.editions (
  id            uuid primary key,
  collection_id uuid,
  external_id   text
);

CREATE TABLE public.edition_fmv_current (
  edition_id    uuid primary key,
  collection_id uuid,
  fmv_usd       numeric,
  confidence    public.fmv_confidence,
  computed_at   timestamptz,
  refreshed_at  timestamptz
);

CREATE TABLE public.wallet_moments_cache (
  id             bigserial primary key,
  wallet_address text,
  collection_id  uuid,
  edition_key    text,
  fmv_usd        numeric,
  fmv_confidence public.fmv_confidence
);

CREATE TABLE public.rwfc_applied (
  edition_id uuid PRIMARY KEY,
  fmv_usd    numeric NOT NULL,
  confidence public.fmv_confidence,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- >>> BEGIN verbatim reconcile_wmc_fmv_for_wallet (keep byte-identical to the migration) >>>
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
-- <<< END verbatim reconcile_wmc_fmv_for_wallet <<<

-- Fixture: one wallet, three editions in one collection.
--   A: the lane pushed 0.16 AFTER efc last refreshed; efc still says 0.10  -> must NOT be written back.
--   B: efc refreshed AFTER the lane's push and agrees with nothing in wmc  -> efc wins (it is newer).
--   C: no rwfc_applied row at all                                         -> efc is copied as before.
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'A'),
  ('00000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'B'),
  ('00000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 'C');

INSERT INTO public.edition_fmv_current VALUES
  ('00000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 0.10, 'MEDIUM', now() - interval '1 day',  now() - interval '40 minutes'),
  ('00000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 0.30, 'HIGH',   now() - interval '50 minutes', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 2.00, 'LOW',    now() - interval '2 hours', now() - interval '1 hour');

INSERT INTO public.rwfc_applied VALUES
  ('00000000-0000-0000-0000-00000000000a', 0.16, 'MEDIUM', now() - interval '30 minutes'),
  ('00000000-0000-0000-0000-00000000000b', 0.25, 'HIGH',   now() - interval '45 minutes');

INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, fmv_usd, fmv_confidence) VALUES
  ('0xabc', '11111111-1111-1111-1111-111111111111', 'A', 0.16, 'MEDIUM'),
  ('0xabc', '11111111-1111-1111-1111-111111111111', 'B', 0.25, 'HIGH'),
  ('0xabc', '11111111-1111-1111-1111-111111111111', 'C', 1.50, 'LOW');

SELECT _assert_eq(public.reconcile_wmc_fmv_for_wallet('0xABC')::text, '2', 'writes B and C only (and folds the 0x address)');

SELECT _assert_eq((SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE edition_key = 'A'), '0.16',
  'A: the lane''s newer price is NOT overwritten by a stale edition_fmv_current');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE edition_key = 'B'), '0.30',
  'B: edition_fmv_current refreshed after the lane''s push, so it wins');
SELECT _assert_eq((SELECT fmv_usd::text || ' ' || fmv_confidence::text FROM public.wallet_moments_cache WHERE edition_key = 'C'), '2.00 LOW',
  'C: no rwfc_applied row -> copied exactly as before the fix');

-- Once efc catches up (refreshed after the push, same value), A is a no-op, not a skip-forever.
UPDATE public.edition_fmv_current SET fmv_usd = 0.16, refreshed_at = now() WHERE edition_id = '00000000-0000-0000-0000-00000000000a';
SELECT _assert_eq(public.reconcile_wmc_fmv_for_wallet('0xabc')::text, '0', 'idempotent once efc agrees');

ROLLBACK;
