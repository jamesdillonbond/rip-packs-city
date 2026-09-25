-- 2026-09-25 (PT) — three All Day pack distributions carried image_url on
-- storage.cloud.google.com (the GCS console host: a 302 to a sign-in), which
-- the CSP img-src does not allow, so /nfl-all-day/packs logged "Refused to
-- load the image" and drew no art for them. The same objects serve publicly
-- (200 image/png) on storage.googleapis.com, which the CSP already allows and
-- 384 other rows already use. Data fix; idempotent.
-- Revert: the reverse replace on the same three rows.
UPDATE public.pack_distributions
   SET image_url = replace(image_url, 'https://storage.cloud.google.com/', 'https://storage.googleapis.com/')
 WHERE image_url LIKE 'https://storage.cloud.google.com/%';
