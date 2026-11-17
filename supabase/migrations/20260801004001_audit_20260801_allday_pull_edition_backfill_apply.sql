-- Apply the staged AllDay pack-pull edition attribution. Fill-only.
-- REVERT:
--   UPDATE public.allday_pack_pull p SET edition_id = NULL
--     FROM public.audit_20260801_allday_pull_edition_backfill a
--    WHERE p.moment_nft_id = a.moment_nft_id AND p.edition_id = a.edition_id;
UPDATE public.allday_pack_pull p
   SET edition_id = a.edition_id,
       updated_at = now()
  FROM public.audit_20260801_allday_pull_edition_backfill a
 WHERE p.moment_nft_id = a.moment_nft_id
   AND p.edition_id IS NULL;