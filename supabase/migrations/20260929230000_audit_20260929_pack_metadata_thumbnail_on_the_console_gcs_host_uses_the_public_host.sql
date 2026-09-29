-- 2026-09-29 (PT): the 09-25 fix (20260925081819) moved three All Day pack distributions' image_url off
-- storage.cloud.google.com (the GCS console host: a 302 to a Google sign-in page) onto the public
-- storage.googleapis.com, but left metadata->>'thumbnail' on the console host. pack_table_rows serves
-- COALESCE(metadata->>'thumbnail', image_url), so the thumbnail won and /nfl-all-day/packs still drew no
-- art ("violates the Content Security Policy"; found by the 09-29 mobile sweep). Same three rows (dists
-- 451, 567, 568); the public URL answers 200 image/png. Data fix; idempotent.
-- Revert: UPDATE public.pack_distributions d SET metadata = b.metadata
--         FROM public.audit_20260929_pack_dist_thumbnail_host_backup b WHERE d.id = b.id;
CREATE TABLE IF NOT EXISTS public.audit_20260929_pack_dist_thumbnail_host_backup AS
  SELECT id, metadata FROM public.pack_distributions
   WHERE metadata->>'thumbnail' LIKE 'https://storage.cloud.google.com/%';
ALTER TABLE public.audit_20260929_pack_dist_thumbnail_host_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260929_pack_dist_thumbnail_host_backup FROM PUBLIC, anon, authenticated;

UPDATE public.pack_distributions
   SET metadata = jsonb_set(metadata, '{thumbnail}',
         to_jsonb(replace(metadata->>'thumbnail', 'https://storage.cloud.google.com/', 'https://storage.googleapis.com/')))
 WHERE metadata->>'thumbnail' LIKE 'https://storage.cloud.google.com/%';
