-- audit_20260922_fill_wmc_edition_key_only_where_two_independent_sources_agree
--
-- 19,625 Top Shot wallet_moments_cache rows carry edition_key IS NULL. They are
-- written by app/api/wallet-search/route.ts, whose `unresolvedRows` path maps through
-- a baseRow() that has no edition_key field, so the INSERT omits the column. (NOT the
-- drain: the drain writes "" and upsert_wmc_batch stores edition_key as sent — and TS
-- wmc contains ZERO empty-string rows.)
--
-- They are permanently orphaned rather than awaiting a retry, because the healer that
-- would fill them — rpc_wmc_selfheal_recent — requires `wmc.edition_key IS NOT NULL`
-- and JOINs editions on it. It can never heal a NULL key. A NULL-key row renders as a
-- real holding with no player and no FMV.
--
-- 4,645 of the 19,625 are resolvable via moment_id -> moments.nft_id -> edition_id ->
-- editions.external_id, a path no current healer uses. This migration does NOT fill all
-- of them. A WRONG edition_key is a SUBSTITUTION defect — it shows the collector another
-- moment's player and FMV — which is strictly worse than an honest "unknown", so the fill
-- is gated on independent corroboration.
--
-- The control (the reason this is safe to run at all): the usual arithmetic mis-key
-- detector, serial_number > circulation_count, is VACUOUS here — serial_number is NULL on
-- all 4,645 candidates, so it returns impossible=0 AND consistent=0 and cannot see the
-- property. Two other tables carry their own nft_id -> edition mapping, written by
-- different writers than `moments`:
--     sales.nft_id -> sales.edition_id      : 2,590 covered, 2,570 agree,  20 disagree
--     topshot_moment_subeditions.nft_id     : 2,018 covered, 2,005 agree,  13 disagree
-- ~99.3% corroboration, and critically NOT 100% — the control detects disagreement, so it
-- is a live check and not a vacuous one.
--
-- Disposition of the 4,645:
--   FILL   corroborated by >=1 source, contradicted by neither  3,276 rows (ALL 10 seeded)
--   HOLD   uncorroborated, `moments` is the only source         1,336 rows (0 seeded)
--   EXCLUDE contradicted by either source                          33 rows (0 seeded)
-- HOLD rows keep an honest NULL rather than a ~0.7%-expected-error name.
--
-- REVERT: the audit table below records every id this migration touched, so the revert is
--   UPDATE public.wallet_moments_cache w SET edition_key = NULL
--     FROM public.audit_20260922_wmc_edition_key_backfill b
--    WHERE w.id = b.id AND w.edition_key = b.filled_key;
-- Do NOT try to re-derive the set afterwards — the fill destroys the predicate that defines it.

CREATE TABLE IF NOT EXISTS public.audit_20260922_wmc_edition_key_backfill AS
WITH cand AS (
  SELECT w.id, w.wallet_address, w.moment_id, e.external_id AS proposed_key
  FROM public.wallet_moments_cache w
  JOIN public.moments  m ON m.nft_id = w.moment_id AND m.collection_id = w.collection_id
  JOIN public.editions e ON e.id = m.edition_id
  WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND w.edition_key IS NULL
),
xref AS (
  SELECT c.*,
    (SELECT es.external_id FROM public.sales s
       JOIN public.editions es ON es.id = s.edition_id
      WHERE s.nft_id = c.moment_id
        AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
        AND s.edition_id IS NOT NULL
      LIMIT 1) AS sales_key,
    (SELECT sub.base_external_id FROM public.topshot_moment_subeditions sub
      WHERE sub.nft_id = c.moment_id LIMIT 1) AS sub_base_key
  FROM cand c
)
SELECT id, wallet_address, moment_id, proposed_key AS filled_key,
       sales_key, sub_base_key, now() AS filled_at
FROM xref
WHERE -- corroborated by at least one independent source ...
      ( (sales_key    IS NOT NULL AND sales_key    = proposed_key)
     OR (sub_base_key IS NOT NULL AND sub_base_key = split_part(proposed_key, '::', 1)) )
  -- ... and contradicted by neither
  AND NOT (sales_key    IS NOT NULL AND sales_key    <> proposed_key)
  AND NOT (sub_base_key IS NOT NULL AND sub_base_key <> split_part(proposed_key, '::', 1));

ALTER TABLE public.audit_20260922_wmc_edition_key_backfill
  ADD CONSTRAINT audit_20260922_wmc_edition_key_backfill_pkey PRIMARY KEY (id);

-- audit_* convention (selfheal_audit_table_rls sweeps for exactly this): RLS on, no
-- anon/authenticated reach. NOT revoked FROM PUBLIC — no pg_cron caller to orphan.
ALTER TABLE public.audit_20260922_wmc_edition_key_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260922_wmc_edition_key_backfill FROM anon, authenticated;

COMMENT ON TABLE public.audit_20260922_wmc_edition_key_backfill IS
  'Revert ledger for the 2026-09-22 TS wmc edition_key fill. One row per wallet_moments_cache row filled, with the two independent cross-reference values that corroborated it. Revert = set edition_key back to NULL for these ids where it still equals filled_key.';

-- The fill. `edition_key IS NULL` keeps it idempotent and prevents clobbering anything a
-- concurrent writer landed between the snapshot above and this statement.
UPDATE public.wallet_moments_cache w
   SET edition_key = b.filled_key
  FROM public.audit_20260922_wmc_edition_key_backfill b
 WHERE w.id = b.id
   AND w.edition_key IS NULL;
