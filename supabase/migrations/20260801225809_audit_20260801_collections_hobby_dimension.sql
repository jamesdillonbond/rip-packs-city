-- PHASE 3 GROUNDWORK — the HOBBY axis (Trevor, 2026-08-01).
-- Product direction: a second navigation axis alongside collection — Basketball /
-- Football / Baseball / Soccer / MMA / Entertainment / Comics / Pokemon — carrying
-- the same six sections (My Wallet, Market, Sniper, Play, Sets, Analytics), plus
-- collection-agnostic Team Hub pages (e.g. the Blazers across Top Shot AND Panini).
--
-- This mirrors the EXACT precedent already established for `chain`:
--   * the dimension lives ONLY on `collections` (never duplicated onto dependent
--     tables — every dependent row reaches it via the collection_id FK);
--   * it is a Postgres enum so values can't drift;
--   * a canonical join VIEW (`collection_hobbies`, mirroring `collection_chains`)
--     is the single supported way to derive hobby from any collection_id FK.
-- Purely ADDITIVE: nullable column, no default, no behaviour change. Nothing reads
-- it yet — this exists so the Hobby axis is a query away rather than a migration away.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hobby_type') THEN
    CREATE TYPE public.hobby_type AS ENUM (
      'basketball', 'football', 'baseball', 'soccer',
      'mma', 'entertainment', 'comics', 'pokemon'
    );
  END IF;
END
$mig$;

ALTER TABLE public.collections
  ADD COLUMN IF NOT EXISTS hobby public.hobby_type;

COMMENT ON COLUMN public.collections.hobby IS
  'Hobby/sport axis (Trevor 2026-08-01). Mirrors the `chain` convention: lives ONLY here, dependent rows reach it via collection_id. Expand with ALTER TYPE hobby_type ADD VALUE. Nullable on purpose — a new collection must state its hobby explicitly rather than inherit a wrong default.';

-- Seed the 7 known collections. Panini WC Prizm is the FIFA World Cup set, so soccer.
UPDATE public.collections SET hobby = 'basketball'::public.hobby_type    WHERE slug = 'nba_top_shot'      AND hobby IS NULL;
UPDATE public.collections SET hobby = 'football'::public.hobby_type      WHERE slug = 'nfl_all_day'       AND hobby IS NULL;
UPDATE public.collections SET hobby = 'soccer'::public.hobby_type        WHERE slug = 'laliga_golazos'    AND hobby IS NULL;
UPDATE public.collections SET hobby = 'mma'::public.hobby_type           WHERE slug = 'ufc_strike'        AND hobby IS NULL;
UPDATE public.collections SET hobby = 'entertainment'::public.hobby_type WHERE slug = 'disney_pinnacle'   AND hobby IS NULL;
UPDATE public.collections SET hobby = 'baseball'::public.hobby_type      WHERE slug = 'candy_mlb'         AND hobby IS NULL;
UPDATE public.collections SET hobby = 'soccer'::public.hobby_type        WHERE slug = 'panini_blockchain' AND hobby IS NULL;

CREATE INDEX IF NOT EXISTS idx_collections_hobby ON public.collections (hobby);

-- Canonical join point, mirroring `collection_chains` exactly. Use this on any FK
-- that points at collections.id to derive hobby (and chain) without repeating the join.
CREATE OR REPLACE VIEW public.collection_hobbies AS
SELECT c.id AS collection_id, c.hobby, c.chain, c.slug, c.name, c.is_active
  FROM public.collections c;

ALTER VIEW public.collection_hobbies SET (security_invoker = on);
COMMENT ON VIEW public.collection_hobbies IS
  'Canonical hobby/chain join point for any collection_id FK. Mirrors collection_chains. security_invoker=on so base-table RLS governs.';

GRANT SELECT ON public.collection_hobbies TO anon, authenticated, service_role;