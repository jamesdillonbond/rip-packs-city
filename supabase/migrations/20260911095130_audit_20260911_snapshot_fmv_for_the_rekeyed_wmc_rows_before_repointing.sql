-- 2026-09-11. Step 1 of 2 — SNAPSHOT ONLY, no write to wallet_moments_cache.
--
-- ⚠ SPLIT FROM THE UPDATE ON PURPOSE. The combined statement died twice at the
-- API gateway because the wmc write contends with the FMV writers (jobids
-- 302/303) — register item D8's row-lock contention, whose recorded remedy is
-- CHUNK IT. Capturing the before-state in its own cheap, read-mostly migration
-- means the revert path exists even if the write has to be retried repeatedly.
--
-- ⚠ Snapshot BEFORE the write: `UPDATE ... RETURNING` yields the NEW row, so an
-- after-the-fact capture would store a value that never existed.
--
-- anon-exec: n/a — no function is created here; this migration is data only.

CREATE TABLE IF NOT EXISTS public.audit_20260911_wmc_rekey_fmv_repoint (
  wallet_address text NOT NULL,
  moment_id      text NOT NULL,
  old_fmv_usd    numeric,
  new_fmv_usd    numeric,
  old_confidence text,
  new_confidence text,
  applied_at     timestamptz,
  PRIMARY KEY (wallet_address, moment_id)
);

COMMENT ON TABLE public.audit_20260911_wmc_rekey_fmv_repoint IS
  'Before/after FMV for the 2026-09-11 wmc parallel->base re-key follow-through. applied_at NULL = snapshotted but not yet written. Revert source.';

INSERT INTO public.audit_20260911_wmc_rekey_fmv_repoint
  (wallet_address, moment_id, old_fmv_usd, new_fmv_usd, old_confidence, new_confidence)
SELECT w.wallet_address, w.moment_id, w.fmv_usd, l.fmv_usd,
       w.fmv_confidence::text, l.confidence::text
  FROM public.audit_20260911_wmc_parallel_to_base_rekey a
  JOIN public.wallet_moments_cache w
    ON w.wallet_address = a.wallet_address AND w.moment_id = a.moment_id
   AND w.collection_id  = a.collection_id
  JOIN public.editions e
    ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
  JOIN public.edition_fmv_current l ON l.edition_id = e.id
 WHERE l.fmv_usd IS NOT NULL
   AND (w.fmv_usd IS DISTINCT FROM l.fmv_usd OR w.fmv_confidence::text IS DISTINCT FROM l.confidence::text)
ON CONFLICT (wallet_address, moment_id) DO NOTHING;