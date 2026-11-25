-- audit_20261125_pinnacle_signed_media_cache
--
-- 2026-11-25 ~8:00 AM PT (Claude Code cloud; Trevor: "Keep digging and probing" → "Figure it out").
-- WHY. Pinnacle share cards lose their art. /api/public/pinnacle-image/<render_id> resolves a SIGNED Dapper
-- CDN url per request. Its primary source (studio-platform GraphQL) answers 530 since ~11-17 (Vercel
-- external-API metrics: max 251 ms, i.e. fails fast), so EVERY image is read from disneypinnacle.com's
-- ~270 KB edition page: 2,500–3,900 fetches/day, p95 ~1 s, but max = the 10 s timeout in 4 of the last 24
-- hours (8 PM–1 AM PT). Vercel's image optimizer gives up on a local source at ~7 s (three 11-25 cases died
-- 7.05 s in, MODULE_NOT_FOUND on /_next/image), and the OG builder's art budget is 4.5 s for all legs.
-- WHAT. One row per (render_id, variant): the last signed url and its expiry. The route serves an
-- unexpired row without touching any upstream, so the slow page is read about once per pin per day
-- (signatures live ~24 h) instead of once per cold request per region.
-- Service-role only (the route uses supabaseAdmin); RLS on with no policy, anon/authenticated revoked.
-- REVERT: DROP TABLE public.pinnacle_signed_media; (the route treats a failed read as a miss)

CREATE TABLE IF NOT EXISTS public.pinnacle_signed_media (
  render_id  text        NOT NULL,
  variant    text        NOT NULL CHECK (variant IN ('front', 'quarter', 'thumb')),
  url        text        NOT NULL,
  expires_at timestamptz NOT NULL,
  source     text        NOT NULL CHECK (source IN ('gql', 'edition-page')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (render_id, variant)
);

ALTER TABLE public.pinnacle_signed_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinnacle_signed_media FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pinnacle_signed_media TO service_role;
