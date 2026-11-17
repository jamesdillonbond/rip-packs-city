-- 2026-09-25 (PT) — ONE name for Steph Curry on every surface (Trevor: "We
-- shouldn't have it split up for naming amongst a single player").
--
-- The merge (20260925135939) left one PLAYER, but labels were still split:
-- editions 106 "Steph" / 17 "Stephen" (player_name) and 92 / 31 (name),
-- wallet_moments_cache 11,179 / 1,626, badge_editions 107 / 8, cached_listings
-- and ts_listings 160 / 2, topshot_ipfs_assets 111 / 13.
--
-- WHICH NAME. Trevor offered "Stephen Curry if that makes more sense". It does
-- not: Top Shot's own metadata says "Steph Curry" on 111 of 124 assets. The
-- refreshed caches copy that metadata, so under "Stephen" ~90% of rows would
-- flip back on every walk; under "Steph" only the 13 plays Top Shot labels
-- "Stephen" need correcting, and (2) corrects them at write time. Search keeps
-- working both ways: "steph curry" matches the name itself, and "stephen curry"
-- matches through the alias (4).
--
-- (1) normalize_player_name_alias(): a BEFORE trigger that rewrites an ALIAS
--     spelling (player_name_aliases) to the player's canonical name, and on
--     editions the "<player> — <set>" label with it. It fires only on INSERT and
--     on an UPDATE that CHANGES player_name (WHEN clause, evaluated before the
--     function is called), so the ~90M no-change upserts on
--     wallet_moments_cache never enter it. Named a_* to run before the
--     existing BEFORE triggers.
-- (2) Triggers on editions, wallet_moments_cache, cached_listings,
--     badge_editions and ts_listings (Top Shot only; no collection_id column,
--     so the collection is the trigger argument). topshot_ipfs_assets has had
--     no writes since stats reset: corrected once, no trigger.
-- (3) One-time correction of the existing "Stephen Curry" rows (Top Shot).
--     wallet_moments_cache is reached through idx_wmc_coll_ek_serial_cover by
--     his editions' keys (1,626 rows), never a scan of the 3 GB table.
-- (4) rpc_search_catalog's player arm also matches a player's aliases. Live
--     prosrc md5 4ed64539… == 20260925102428 (re-read 09-25 ~8:00 AM PT);
--     only the player_raw WHERE changes.
--
-- Backup: audit_20260925_curry_label_backup (editions id, old player_name, old
-- name). Revert: DROP the ten a_normalize_player_name_alias_* triggers and the
-- function; restore editions from the backup; the caches re-take Top Shot's
-- labels on their next refresh; re-apply 20260925102428 for search.

-- (1)
-- anon-exec: intentional — normalize_player_name_alias is a trigger function; REVOKEd from PUBLIC, anon and authenticated below.
CREATE OR REPLACE FUNCTION public.normalize_player_name_alias()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll uuid;
  v_slug text;
  v_name text;
BEGIN
  IF NEW.player_name IS NULL OR btrim(NEW.player_name) = '' THEN
    RETURN NEW;
  END IF;
  -- a table without a collection_id column passes its collection as the argument
  IF TG_NARGS > 0 THEN
    v_coll := TG_ARGV[0]::uuid;
  ELSE
    v_coll := NEW.collection_id;
  END IF;
  IF v_coll IS NULL THEN
    RETURN NEW;
  END IF;

  v_slug := regexp_replace(lower(trim(extensions.unaccent(NEW.player_name))), '[^a-z0-9]+', '-', 'g');
  SELECT p.name INTO v_name
    FROM public.player_name_aliases a
    JOIN public.players p ON p.id = a.player_id
   WHERE a.collection_id = v_coll
     AND a.alias_slug = v_slug;
  IF v_name IS NULL OR v_name = NEW.player_name THEN
    RETURN NEW;
  END IF;

  -- editions also carry the house label "<player> — <set>". Nested, never one
  -- AND: PL/pgSQL does not short-circuit, and NEW.name does not exist on the
  -- cache tables this trigger also serves.
  IF TG_TABLE_NAME = 'editions' THEN
    IF NEW.name IS NOT NULL AND starts_with(NEW.name, NEW.player_name || ' ') THEN
      NEW.name := v_name || substr(NEW.name, length(NEW.player_name) + 1);
    END IF;
  END IF;
  NEW.player_name := v_name;
  RETURN NEW;
END
$function$;
REVOKE EXECUTE ON FUNCTION public.normalize_player_name_alias() FROM PUBLIC, anon, authenticated;

-- (2)
DROP TRIGGER IF EXISTS a_normalize_player_name_alias_ins ON public.editions;
CREATE TRIGGER a_normalize_player_name_alias_ins BEFORE INSERT ON public.editions
  FOR EACH ROW WHEN (NEW.player_name IS NOT NULL)
  EXECUTE FUNCTION public.normalize_player_name_alias();
DROP TRIGGER IF EXISTS a_normalize_player_name_alias_upd ON public.editions;
CREATE TRIGGER a_normalize_player_name_alias_upd BEFORE UPDATE OF player_name ON public.editions
  FOR EACH ROW WHEN (NEW.player_name IS DISTINCT FROM OLD.player_name)
  EXECUTE FUNCTION public.normalize_player_name_alias();
DROP TRIGGER IF EXISTS a_normalize_player_name_alias_ins ON public.wallet_moments_cache;
CREATE TRIGGER a_normalize_player_name_alias_ins BEFORE INSERT ON public.wallet_moments_cache
  FOR EACH ROW WHEN (NEW.player_name IS NOT NULL)
  EXECUTE FUNCTION public.normalize_player_name_alias();
DROP TRIGGER IF EXISTS a_normalize_player_name_alias_upd ON public.wallet_moments_cache;
CREATE TRIGGER a_normalize_player_name_alias_upd BEFORE UPDATE OF player_name ON public.wallet_moments_cache
  FOR EACH ROW WHEN (NEW.player_name IS DISTINCT FROM OLD.player_name)
  EXECUTE FUNCTION public.normalize_player_name_alias();
DROP TRIGGER IF EXISTS a_normalize_player_name_alias_ins ON public.cached_listings;
CREATE TRIGGER a_normalize_player_name_alias_ins BEFORE INSERT ON public.cached_listings
  FOR EACH ROW WHEN (NEW.player_name IS NOT NULL)
  EXECUTE FUNCTION public.normalize_player_name_alias();
DROP TRIGGER IF EXISTS a_normalize_player_name_alias_upd ON public.cached_listings;
CREATE TRIGGER a_normalize_player_name_alias_upd BEFORE UPDATE OF player_name ON public.cached_listings
  FOR EACH ROW WHEN (NEW.player_name IS DISTINCT FROM OLD.player_name)
  EXECUTE FUNCTION public.normalize_player_name_alias();
DROP TRIGGER IF EXISTS a_normalize_player_name_alias_ins ON public.badge_editions;
CREATE TRIGGER a_normalize_player_name_alias_ins BEFORE INSERT ON public.badge_editions
  FOR EACH ROW WHEN (NEW.player_name IS NOT NULL)
  EXECUTE FUNCTION public.normalize_player_name_alias();
DROP TRIGGER IF EXISTS a_normalize_player_name_alias_upd ON public.badge_editions;
CREATE TRIGGER a_normalize_player_name_alias_upd BEFORE UPDATE OF player_name ON public.badge_editions
  FOR EACH ROW WHEN (NEW.player_name IS DISTINCT FROM OLD.player_name)
  EXECUTE FUNCTION public.normalize_player_name_alias();
DROP TRIGGER IF EXISTS a_normalize_player_name_alias_ins ON public.ts_listings;
CREATE TRIGGER a_normalize_player_name_alias_ins BEFORE INSERT ON public.ts_listings
  FOR EACH ROW WHEN (NEW.player_name IS NOT NULL)
  EXECUTE FUNCTION public.normalize_player_name_alias('95f28a17-224a-4025-96ad-adf8a4c63bfd');
DROP TRIGGER IF EXISTS a_normalize_player_name_alias_upd ON public.ts_listings;
CREATE TRIGGER a_normalize_player_name_alias_upd BEFORE UPDATE OF player_name ON public.ts_listings
  FOR EACH ROW WHEN (NEW.player_name IS DISTINCT FROM OLD.player_name)
  EXECUTE FUNCTION public.normalize_player_name_alias('95f28a17-224a-4025-96ad-adf8a4c63bfd');

-- (3)
CREATE TABLE IF NOT EXISTS public.audit_20260925_curry_label_backup (
  edition_id   uuid PRIMARY KEY,
  player_name  text,
  name         text,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260925_curry_label_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_curry_label_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_ts   CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_keep CONSTANT uuid := 'c722ea7c-331e-469e-8dad-87c6fe3e52a2';
  n_ed int; n_wmc int; n_cl int; n_be int; n_tl int; n_ipfs int; v_left int;
BEGIN
  IF (SELECT name FROM public.players WHERE id = v_keep) IS DISTINCT FROM 'Steph Curry' THEN
    RAISE EXCEPTION 'the canonical Curry row is not named Steph Curry';
  END IF;

  INSERT INTO public.audit_20260925_curry_label_backup (edition_id, player_name, name)
  SELECT e.id, e.player_name, e.name FROM public.editions e
   WHERE e.collection_id = v_ts
     AND (e.player_name = 'Stephen Curry' OR e.name LIKE 'Stephen Curry %')
  ON CONFLICT (edition_id) DO NOTHING;

  WITH u AS (
    UPDATE public.editions
       SET player_name = 'Steph Curry',
           name = CASE WHEN name LIKE 'Stephen Curry %'
                       THEN 'Steph Curry' || substr(name, length('Stephen Curry') + 1)
                       ELSE name END
     WHERE collection_id = v_ts
       AND (player_name = 'Stephen Curry' OR name LIKE 'Stephen Curry %')
    RETURNING 1)
  SELECT count(*) INTO n_ed FROM u;

  WITH u AS (
    UPDATE public.wallet_moments_cache w SET player_name = 'Steph Curry'
     WHERE w.collection_id = v_ts
       AND w.edition_key IN (SELECT e.external_id FROM public.editions e WHERE e.player_id = v_keep)
       AND w.player_name = 'Stephen Curry'
    RETURNING 1)
  SELECT count(*) INTO n_wmc FROM u;

  WITH u AS (UPDATE public.cached_listings SET player_name = 'Steph Curry'
              WHERE collection_id = v_ts AND player_name = 'Stephen Curry' RETURNING 1)
  SELECT count(*) INTO n_cl FROM u;
  WITH u AS (UPDATE public.badge_editions SET player_name = 'Steph Curry'
              WHERE collection_id = v_ts AND player_name = 'Stephen Curry' RETURNING 1)
  SELECT count(*) INTO n_be FROM u;
  WITH u AS (UPDATE public.ts_listings SET player_name = 'Steph Curry'
              WHERE player_name = 'Stephen Curry' RETURNING 1)
  SELECT count(*) INTO n_tl FROM u;
  WITH u AS (UPDATE public.topshot_ipfs_assets SET player_name = 'Steph Curry'
              WHERE player_name = 'Stephen Curry' RETURNING 1)
  SELECT count(*) INTO n_ipfs FROM u;

  RAISE NOTICE 'Curry labels: editions %, wmc %, cached_listings %, badge_editions %, ts_listings %, ipfs %',
    n_ed, n_wmc, n_cl, n_be, n_tl, n_ipfs;

  SELECT count(*) INTO v_left FROM public.editions
   WHERE collection_id = v_ts AND (player_name = 'Stephen Curry' OR name LIKE 'Stephen Curry %');
  IF v_left <> 0 THEN RAISE EXCEPTION '% editions still say Stephen Curry', v_left; END IF;
END $$;

-- Controls. Positive: an UPDATE of a real edition to the alias spelling comes
-- back as "Steph Curry". The rest run on a temp table carrying the same trigger:
-- an alias spelling is rewritten; another player's name, and the alias spelling
-- in ANOTHER collection, pass through untouched (no-change controls the fix
-- cannot move).
DO $$
DECLARE
  v_ts  CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_ad  CONSTANT uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_a text;
BEGIN
  UPDATE public.editions SET player_name = 'Stephen Curry'
   WHERE id = (SELECT id FROM public.editions WHERE collection_id = v_ts AND player_name = 'Steph Curry' LIMIT 1)
  RETURNING player_name INTO v_a;
  IF v_a IS DISTINCT FROM 'Steph Curry' THEN
    RAISE EXCEPTION 'trigger did not normalize an UPDATE to Stephen Curry (got %)', v_a;
  END IF;

  CREATE TEMP TABLE _pn_ctl (collection_id uuid, player_name text) ON COMMIT DROP;
  CREATE TRIGGER a_ctl BEFORE INSERT ON _pn_ctl FOR EACH ROW
    WHEN (NEW.player_name IS NOT NULL) EXECUTE FUNCTION public.normalize_player_name_alias();
  INSERT INTO _pn_ctl VALUES (v_ts, 'Stephen Curry'), (v_ts, '  STEPHEN  curry '),
                             (v_ts, 'LeBron James'), (v_ad, 'Stephen Curry');
  IF (SELECT count(*) FROM _pn_ctl WHERE collection_id = v_ts AND player_name = 'Steph Curry') <> 2 THEN
    RAISE EXCEPTION 'alias spellings were not both normalized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM _pn_ctl WHERE player_name = 'LeBron James') THEN
    RAISE EXCEPTION 'no-change control moved: LeBron James was rewritten';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM _pn_ctl WHERE collection_id = v_ad AND player_name = 'Stephen Curry') THEN
    RAISE EXCEPTION 'no-change control moved: an alias leaked across collections';
  END IF;
END $$;

-- (4)
-- anon-exec: unchanged (rpc_search_catalog) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege('anon') = false read 09-25.
CREATE OR REPLACE FUNCTION public.rpc_search_catalog(p_q text, p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
 RETURNS TABLE(kind text, label text, sublabel text, slug text, collection_id uuid, collection_slug text, thumbnail_url text, edition_count integer, score real)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_q      text := lower(btrim(coalesce(p_q, '')));
  v_tokens text[];
  v_anchor text;
  v_pats   text[];
  -- 2026-09-25: the PLAYER arm matches with accents folded on both sides, so
  -- "doncic" finds Luka Dončić and "şengün" finds "Alperen Sengun". The other
  -- arms keep the raw query: their predicates ride trigram indexes an
  -- unaccent() wrapper would forfeit, and players is small enough not to need one.
  v_qa     text;
  v_anchor_a text;
  v_pats_a text[];
  v_n      int;
  v_need   int;
  v_limit  int  := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_pin    CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_ts     CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  IF length(v_q) < 2 THEN RETURN; END IF;

  v_tokens := array_remove(regexp_split_to_array(v_q, '\s+'), '');
  v_n := coalesce(array_length(v_tokens, 1), 0);
  IF v_n = 0 THEN RETURN; END IF;

  SELECT t INTO v_anchor FROM unnest(v_tokens) AS t ORDER BY length(t) DESC, t LIMIT 1;
  SELECT array_agg('%' || t || '%') INTO v_pats FROM unnest(v_tokens) AS t;
  v_qa := lower(btrim(extensions.unaccent(v_q)));
  v_anchor_a := lower(extensions.unaccent(v_anchor));
  SELECT array_agg('%' || lower(extensions.unaccent(t)) || '%') INTO v_pats_a FROM unnest(v_tokens) AS t;

  -- A narrative query is a DESCRIPTION, not an incantation: "lillard buzzer
  -- beater" must not return nothing merely because the prose says "buzzer" and
  -- never says "beater".
  --
  -- A 3+-token query may therefore miss ONE token. A 1- or 2-token query still
  -- must match every one: relaxing THERE would degrade "lillard buzzer" into
  -- every Lillard moment, which is a worse answer than none.
  v_need := CASE WHEN v_n >= 3 THEN v_n - 1 ELSE v_n END;

  RETURN QUERY
  WITH
  player_raw AS (
    SELECT
      p.collection_id AS cid, p.name AS nm, p.headshot_url AS thumb,
      CASE
        WHEN p.collection_id = v_pin
          THEN (SELECT count(*) FROM public.pinnacle_catalog pc WHERE pc.character_name = p.name)
        ELSE (SELECT count(*) FROM public.editions e
                WHERE e.collection_id = p.collection_id
                  AND (e.player_id = p.id OR e.player_name = p.name)
                  AND (e.collection_id <> v_ts
                       OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'))
      END AS n
    FROM public.players p
    WHERE (p_collection_id IS NULL OR p.collection_id = p_collection_id)
      AND ((extensions.unaccent(p.name) ILIKE '%' || v_anchor_a || '%'
            AND lower(extensions.unaccent(p.name)) LIKE ALL (v_pats_a))
           -- 2026-09-25: or a registered ALIAS of the player matches ("stephen
           -- curry" finds the "Steph Curry" row). The slug's dashes read as spaces.
           OR EXISTS (SELECT 1 FROM public.player_name_aliases a
                       WHERE a.player_id = p.id
                         AND replace(a.alias_slug, '-', ' ') LIKE ALL (v_pats_a)))
    LIMIT 300
  ),
  player_hits AS (
    SELECT 'player'::text AS k,
      -- the unaccented slug is the one lib/entity-labels.ts slugifyPlayerName
      -- builds and the canonical /player/ URL carries
      regexp_replace(lower(btrim(extensions.unaccent(nm))), '[^a-z0-9]+', '-', 'g') AS sl,
      cid, min(nm) AS lbl, max(n)::int AS n, max(thumb) AS thumb,
      max(extensions.similarity(lower(extensions.unaccent(nm)), v_qa)) AS sim,
      bool_or(lower(extensions.unaccent(nm)) = v_qa) AS exact,
      bool_or(lower(extensions.unaccent(nm)) LIKE v_anchor_a || '%') AS prefix
    FROM player_raw WHERE n > 0 GROUP BY 1, 2, 3
  ),
  set_raw AS (
    SELECT s.collection_id AS cid, s.name AS nm, s.cover_art_url AS thumb,
      (SELECT count(*) FROM public.editions e
         WHERE e.collection_id = s.collection_id
           AND (e.set_id = s.id OR e.set_name = s.name)
           AND (e.collection_id <> v_ts
                OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')) AS n
    FROM public.sets s
    WHERE (p_collection_id IS NULL OR s.collection_id = p_collection_id)
      AND s.name ILIKE '%' || v_anchor || '%'
      AND lower(s.name) LIKE ALL (v_pats)
    LIMIT 300
  ),
  set_hits AS (
    SELECT 'set'::text AS k,
      regexp_replace(lower(btrim(nm)), '[^a-z0-9]+', '-', 'g') AS sl,
      cid, min(nm) AS lbl, max(n)::int AS n, max(thumb) AS thumb,
      max(extensions.similarity(lower(nm), v_q)) AS sim,
      bool_or(lower(nm) = v_q) AS exact,
      bool_or(lower(nm) LIKE v_anchor || '%') AS prefix
    FROM set_raw WHERE n > 0 GROUP BY 1, 2, 3
  ),
  team_hits AS (
    SELECT 'team'::text AS k,
      regexp_replace(lower(btrim(e.team_name)), '[^a-z0-9]+', '-', 'g') AS sl,
      e.collection_id AS cid, min(e.team_name) AS lbl, count(*)::int AS n,
      NULL::text AS thumb,
      max(extensions.similarity(lower(e.team_name), v_q)) AS sim,
      bool_or(lower(e.team_name) = v_q) AS exact,
      bool_or(lower(e.team_name) LIKE v_anchor || '%') AS prefix
    FROM public.editions e
    WHERE (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      AND e.team_name IS NOT NULL
      AND (e.collection_id <> v_ts OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
      AND e.team_name ILIKE '%' || v_anchor || '%'
      AND lower(e.team_name) LIKE ALL (v_pats)
    GROUP BY 1, 2, 3
  ),
  -- Candidates come from the ANCHOR alone, which is what keeps every branch
  -- trigram-index-backed (idx_editions_description_trgm for the prose arm).
  -- Token coverage is then a refinement, never an index predicate.
  edition_cand AS (
    SELECT e.id, e.external_id, e.collection_id, e.player_name, e.set_name,
           e.team_name, e.play_type, e.tier, e.thumbnail_url,
           e.circulation_count, e.description,
           lower(
             coalesce(e.player_name, '')   || ' ' ||
             coalesce(e.set_name, '')      || ' ' ||
             coalesce(e.team_name, '')     || ' ' ||
             coalesce(e.play_type, '')     || ' ' ||
             coalesce(e.play_category, '') || ' ' ||
             -- The prose is what makes a narrative query ("game winner",
             -- "buzzer beater") answerable at all.
             coalesce(e.description, '')
           ) AS combined
    FROM public.editions e
    WHERE (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      AND (e.collection_id <> v_ts OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
      AND (
        (v_q ~ '^\d+:\d+$' AND e.external_id = v_q)
        OR e.player_name ILIKE '%' || v_anchor || '%'
        OR e.set_name    ILIKE '%' || v_anchor || '%'
        OR e.team_name   ILIKE '%' || v_anchor || '%'
        OR e.description ILIKE '%' || v_anchor || '%'
      )
  ),
  edition_hits AS (
    SELECT 'edition'::text AS k,
      coalesce(e.external_id, e.id::text) AS sl,
      e.collection_id AS cid,
      coalesce(e.player_name, 'Unknown') AS lbl,
      1 AS n,
      e.thumbnail_url AS thumb,
      extensions.similarity(
        lower(coalesce(e.player_name, '') || ' ' || coalesce(e.set_name, '')), v_q) AS sim,
      (lower(coalesce(e.external_id, '')) = v_q) AS exact,
      false AS prefix,
      e.set_name AS set_name, e.play_type AS play_type, e.tier::text AS tier,
      (e.description IS NOT NULL AND tok.prose_hit >= v_need) AS via_prose,
      (tok.hit::numeric / v_n) AS cov
    FROM edition_cand e
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE e.combined LIKE pat)::int AS hit,
             count(*) FILTER (WHERE lower(coalesce(e.description, '')) LIKE pat)::int AS prose_hit
      FROM unnest(v_pats) AS pat
    ) tok
    WHERE (lower(coalesce(e.external_id, '')) = v_q) OR tok.hit >= v_need
    -- tok.hit leads the ordering so the 200-row cap can never discard a FULL
    -- match in favour of a partial one.
    ORDER BY (lower(coalesce(e.external_id, '')) = v_q) DESC,
             tok.hit DESC,
             e.circulation_count ASC NULLS LAST
    LIMIT 200
  ),
  unioned AS (
    SELECT k, lbl, NULL::text AS sub, sl, cid, thumb, n, sim, exact, prefix,
           0.35::real AS kw, 1.0::numeric AS cov FROM player_hits
    UNION ALL
    SELECT k, lbl, NULL::text, sl, cid, thumb, n, sim, exact, prefix,
           0.25::real, 1.0::numeric FROM set_hits
    UNION ALL
    SELECT k, lbl, NULL::text, sl, cid, thumb, n, sim, exact, prefix,
           0.20::real, 1.0::numeric FROM team_hits
    UNION ALL
    SELECT k, lbl,
           nullif(concat_ws(' · ', set_name, play_type, tier), ''),
           sl, cid, thumb, n, sim, exact, prefix,
           -- A prose match is a deliberate narrative hit; nudge it above the
           -- incidental name-substring editions.
           CASE WHEN via_prose THEN 0.12::real ELSE 0.00::real END,
           cov
    FROM edition_hits
  )
  SELECT u.k, u.lbl::text, u.sub::text, u.sl::text, u.cid, c.slug::text, u.thumb::text, u.n,
    (coalesce(u.sim, 0)
      + CASE WHEN u.exact THEN 1.0 ELSE 0 END
      + CASE WHEN u.prefix THEN 0.5 ELSE 0 END
      + u.kw
      -- Coverage keeps the relaxation from costing precision: a FULL match
      -- still outranks a partial one. Every entity arm is coverage 1.0, so
      -- this is a constant offset there and existing entity rankings are
      -- unmoved.
      + (u.cov * 0.60)
      + least(coalesce(u.n, 0), 500) / 5000.0
    )::real AS score
  FROM unioned u
  JOIN public.collections c ON c.id = u.cid AND c.is_active
  -- u.sl breaks the remaining ties. Editions of one player tie on score, n AND
  -- label, so without it the output order is whatever the plan happens to
  -- produce -- it visibly reshuffled between two semantically identical
  -- versions of this function while it was being verified.
  ORDER BY score DESC, u.n DESC, u.lbl ASC, u.sl ASC
  LIMIT v_limit;
END
$function$;
