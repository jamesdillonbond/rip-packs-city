-- audit_20260924_allday_custodian_buyer_backfill_to_null
--
-- known-issues #83, decided 2026-09-24 under Trevor's delegation ("make your own judgements …
-- the long term of RPC, and for our users").
--
-- 0xddfbe848a81b2236 is NFL All Day's constant Dapper custodian: a moment deposited there is
-- re-forwarded to the real buyer later. The repo decided in writing (2026-07-19) that naming it as
-- the buyer "would be a lie", and the forward fix (lib/chains/flow/dapper-v1-tx-decode.ts,
-- CUSTODIAL_DEPOSIT_TARGETS, 2026-09-11) writes buyer_address = NULL for new rows. The EXISTING
-- rows were left for this decision. Measured 2026-09-24: 9,758 All Day sales still name it
-- (onchain_dapper_v2 6,744 · onchain_dapper_v1 3,007 · allday_studio_history_v1 7); the last one
-- written sold 2026-09-18 and none since, so the backfill does not race a live writer.
--
-- WHAT: buyer_address → NULL on exactly those rows (NULL = "unknown", which is true; the custodian
-- is not). Scoped to collection = 'nfl_all_day' ONLY — the 41 Top Shot ts_history_backfill_v1 rows
-- naming the same address are a DIFFERENT, unexplained population and are left untouched.
--
-- BACKUP: public.audit_20260924_allday_custodian_buyer_backup (id, buyer_address). Drop after 10-24.
-- REVERT:
--   UPDATE public.sales s SET buyer_address = b.buyer_address
--     FROM public.audit_20260924_allday_custodian_buyer_backup b WHERE s.id = b.id;

CREATE TABLE IF NOT EXISTS public.audit_20260924_allday_custodian_buyer_backup AS
SELECT s.id, s.buyer_address, s.sold_at, s.source
  FROM public.sales s
 WHERE s.collection = 'nfl_all_day'
   AND lower(s.buyer_address) = '0xddfbe848a81b2236';

REVOKE ALL ON public.audit_20260924_allday_custodian_buyer_backup FROM PUBLIC, anon, authenticated;
ALTER TABLE public.audit_20260924_allday_custodian_buyer_backup ENABLE ROW LEVEL SECURITY;

UPDATE public.sales s
   SET buyer_address = NULL
  FROM public.audit_20260924_allday_custodian_buyer_backup b
 WHERE s.id = b.id
   AND s.collection = 'nfl_all_day'
   AND lower(s.buyer_address) = '0xddfbe848a81b2236';

DO $assert$
DECLARE v_left int; v_backup int;
BEGIN
  SELECT count(*) INTO v_left FROM public.sales
   WHERE collection = 'nfl_all_day' AND lower(buyer_address) = '0xddfbe848a81b2236';
  IF v_left <> 0 THEN RAISE EXCEPTION '% All Day sales still name the custodian as buyer', v_left; END IF;
  SELECT count(*) INTO v_backup FROM public.audit_20260924_allday_custodian_buyer_backup;
  IF v_backup < 9000 THEN RAISE EXCEPTION 'backup holds only % rows — expected ~9,758', v_backup; END IF;
END
$assert$;
