-- audit_20260927_pinnacle_live_listings_for_the_sniper
--
-- WHY. The Disney Pinnacle Sniper read listings from Flowty's API, whose
-- marketplace shut down 2026-05-13. Measured live 2026-09-27: it returned 96
-- NFTs whose newest listing dated 2026-08-21, and 2 deals (the same pin twice).
-- Meanwhile the catalog floor sweep (/api/admin/backfill-pinnacle-catalog,
-- 5 runs/day, ok on every recent run) pages EVERY live listing from Disney's own
-- Studio GraphQL (~16,100 listings, 161 pages, ~23 s) and kept only the
-- per-render floor. This table keeps the individual listings that sweep already
-- sees, so the Sniper reads live listings instead of a dead marketplace.
--
-- ⚠ NOT cached_listings_v2. Its 18,546 "open" Pinnacle rows are a change-only
-- event feed, not a census (CLAUDE.md #149): where the seller's wallet is
-- indexed, 263 of 751 "open" listings were for pins the seller no longer held.
-- A listing here is one the marketplace itself returned on its last full sweep.
--
-- Write discipline (CLAUDE.md, R123): the replace function UPSERTS the sweep
-- first and deletes only rows the sweep did NOT write, and the route calls it
-- only after a COMPLETE sweep — a partial sweep never retires live listings.
--
-- Revert:
--   DROP FUNCTION IF EXISTS public.get_pinnacle_live_listings_for_sniper(integer);
--   DROP FUNCTION IF EXISTS public.pinnacle_live_listings_replace(jsonb, timestamptz);
--   DROP TABLE IF EXISTS public.pinnacle_live_listings;

CREATE TABLE IF NOT EXISTS public.pinnacle_live_listings (
  nft_id        text        PRIMARY KEY,
  render_id     text        NOT NULL,
  serial_number integer,
  price_usd     numeric     NOT NULL CHECK (price_usd > 0),
  seen_at       timestamptz NOT NULL
);

COMMENT ON TABLE public.pinnacle_live_listings IS
  'Every live Disney Pinnacle listing as of the last COMPLETE Studio-GraphQL sweep (written by /api/admin/backfill-pinnacle-catalog via pinnacle_live_listings_replace). seen_at = the sweep that last returned the listing; rows the latest complete sweep did not return are deleted. Read by the Sniper through get_pinnacle_live_listings_for_sniper. Service-role only.';

CREATE INDEX IF NOT EXISTS pinnacle_live_listings_render_id_idx ON public.pinnacle_live_listings (render_id);

ALTER TABLE public.pinnacle_live_listings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pinnacle_live_listings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pinnacle_live_listings TO service_role;

-- Replace the live set with one COMPLETE sweep. Upsert first, then delete what
-- this sweep did not write (never delete-then-insert). Returns the counts.
CREATE OR REPLACE FUNCTION public.pinnacle_live_listings_replace(p_rows jsonb, p_seen_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_written integer := 0;
  v_deleted integer := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'pinnacle_live_listings_replace: p_rows must be a non-empty array (an empty sweep never retires the live set)';
  END IF;

  INSERT INTO public.pinnacle_live_listings (nft_id, render_id, serial_number, price_usd, seen_at)
  SELECT DISTINCT ON (r->>'nft_id')
         r->>'nft_id',
         r->>'render_id',
         NULLIF(r->>'serial_number', '')::integer,
         (r->>'price_usd')::numeric,
         p_seen_at
  FROM jsonb_array_elements(p_rows) AS r
  WHERE coalesce(r->>'nft_id', '') <> ''
    AND coalesce(r->>'render_id', '') <> ''
    AND (r->>'price_usd')::numeric > 0
  ORDER BY r->>'nft_id', (r->>'price_usd')::numeric
  ON CONFLICT (nft_id) DO UPDATE
    SET render_id     = EXCLUDED.render_id,
        serial_number = EXCLUDED.serial_number,
        price_usd     = EXCLUDED.price_usd,
        seen_at       = EXCLUDED.seen_at;
  GET DIAGNOSTICS v_written = ROW_COUNT;

  DELETE FROM public.pinnacle_live_listings WHERE seen_at < p_seen_at;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object('written', v_written, 'deleted', v_deleted);
END
$fn$;

-- anon-exec: revoked (pinnacle_live_listings_replace) — a write function; service_role only.
REVOKE EXECUTE ON FUNCTION public.pinnacle_live_listings_replace(jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pinnacle_live_listings_replace(jsonb, timestamptz) TO service_role;

-- The Sniper's read: live listings joined to their render's catalog row, priced
-- renders only, prefiltered to asks under 103% of FMV (the largest serial
-- multiplier the Sniper applies is 1.08 and it keeps only >= 5% discounts, so
-- nothing it could show is cut), best base discount first.
CREATE OR REPLACE FUNCTION public.get_pinnacle_live_listings_for_sniper(p_limit integer DEFAULT 2000)
RETURNS TABLE (
  nft_id text,
  render_id text,
  serial_number integer,
  price_usd numeric,
  seen_at timestamptz,
  character_name text,
  set_name text,
  series_name text,
  variant text,
  total_minted integer,
  edition_type text,
  is_chaser boolean,
  legacy_edition_key text,
  franchises text[],
  fmv_usd numeric,
  fmv_confidence text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT l.nft_id, l.render_id, l.serial_number, l.price_usd, l.seen_at,
         c.character_name, btrim(c.set_name), c.series_name, c.variant, c.total_minted,
         c.edition_type, c.is_chaser, c.legacy_edition_key, c.franchises,
         c.fmv_usd, c.fmv_confidence::text
  FROM public.pinnacle_live_listings l
  JOIN public.pinnacle_catalog c ON c.render_id = l.render_id
  WHERE c.fmv_usd > 0
    AND l.price_usd < c.fmv_usd * 1.03
  ORDER BY (c.fmv_usd - l.price_usd) / c.fmv_usd DESC, l.nft_id
  LIMIT greatest(1, least(coalesce(p_limit, 2000), 5000));
$fn$;

-- anon-exec: revoked (get_pinnacle_live_listings_for_sniper) — read by the server route with the service role only.
REVOKE EXECUTE ON FUNCTION public.get_pinnacle_live_listings_for_sniper(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_live_listings_for_sniper(integer) TO service_role;
