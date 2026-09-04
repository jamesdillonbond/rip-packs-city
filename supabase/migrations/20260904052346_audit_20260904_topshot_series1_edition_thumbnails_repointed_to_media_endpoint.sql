-- audit_20260904_topshot_series1_edition_thumbnails_repointed_to_media_endpoint
-- Applied to prod via MCP apply_migration 2026-09-04 05:23Z (version 20260904052346).
--
-- FINDING (2026-09-04 Playwright/Chrome sweep of the Top Shot team + set pages): every Series 1
-- Top Shot edition thumbnail was a broken image. 850 `editions` rows carried a `thumbnail_url` of
-- the shape `https://assets.nbatopshot.com/editions/1_<set_slug>/<play_uuid>/play_<…>_capture_
-- Hero_2880_2880_Transparent.png` — the retired per-edition asset path. MEASURED: 9 of 9 sampled
-- URLs answered 404 (no other Series carried that path shape; S2+ editions already use the
-- `/media/<moment_id>/image` endpoint). Team pages for the S1 rosters rendered the alt-text box
-- where the Moment art belongs, on both desktop and 390 px.
--
-- FIX: repoint each of the 850 rows to the same `media` endpoint every other Series uses,
-- `https://assets.nbatopshot.com/media/<moment_id>/image?width=512`, using the first
-- `wallet_moments_cache.moment_id` known for that edition in TEXT order (any minted Moment of the
-- edition renders the edition's art; the choice only needs to be deterministic — `moment_id` is
-- text, so this is `min(moment_id)`, lexicographic, NOT the numerically lowest serial; re-verified
-- against the recorded rows 05:35Z). MEASURED: 12 of 12 sampled new URLs answered
-- 200 `image/*`. Editions with no cached Moment (none in this set of 850) are left untouched.
--
-- The previous URLs are preserved in `audit_20260904_s1_thumbnail_backfill` (RLS on, service-only)
-- so the revert is exact. This is a DATA migration on `editions.thumbnail_url` only — no schema
-- change to `editions`, no function, no view.
--
-- REVERT:
--   UPDATE editions e SET thumbnail_url = a.old_thumbnail_url
--   FROM audit_20260904_s1_thumbnail_backfill a WHERE a.edition_id = e.id;
--   -- then, optionally: DROP TABLE audit_20260904_s1_thumbnail_backfill;
-- anon-exec: n/a — this migration creates no function.

CREATE TABLE IF NOT EXISTS public.audit_20260904_s1_thumbnail_backfill (
  edition_id        uuid PRIMARY KEY,
  external_id       text,
  old_thumbnail_url text NOT NULL,
  new_thumbnail_url text NOT NULL,
  moment_id         text NOT NULL,
  applied_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.audit_20260904_s1_thumbnail_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260904_s1_thumbnail_backfill FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.audit_20260904_s1_thumbnail_backfill TO postgres, service_role;

-- Record first (the revert depends on it), then repoint from the record — one transaction.
INSERT INTO public.audit_20260904_s1_thumbnail_backfill (edition_id, external_id, old_thumbnail_url, new_thumbnail_url, moment_id)
SELECT e.id,
       e.external_id,
       e.thumbnail_url,
       'https://assets.nbatopshot.com/media/' || m.moment_id || '/image?width=512',
       m.moment_id
FROM public.editions e
JOIN LATERAL (
  SELECT w.moment_id
  FROM public.wallet_moments_cache w
  WHERE w.edition_key = e.external_id
    AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  ORDER BY w.moment_id ASC   -- text order (= min(moment_id)); see header
  LIMIT 1
) m ON true
WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  AND e.thumbnail_url LIKE 'https://assets.nbatopshot.com/editions/1\_%'
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e
SET thumbnail_url = a.new_thumbnail_url
FROM public.audit_20260904_s1_thumbnail_backfill a
WHERE a.edition_id = e.id
  AND e.thumbnail_url = a.old_thumbnail_url;
