-- 2026-09-25 (PT) — a franchise's HISTORIC ERA belongs to the franchise
-- (Trevor, 7:55 PM PT: "Historic era should be included in that franchise").
-- Until now every team read matched ONE label — /team/las-vegas-raiders
-- counted 114 editions while Oakland (18) and Los Angeles (8) sat under their
-- own pages, and the franchise hub summed the current name only.
--
--  * team_franchise_slugs(collection, slug) → the site slugs of every label in
--    the franchise the slug names (league_team_abbr — historic names, the WNBA
--    arm — else teams_master, else the label alone; accent-tolerant on input).
--    team_franchise_primary_name(collection, slug) → the franchise's current
--    (teams_master) name, else the most-minted label. team_historic_slugs(
--    collection) → every non-primary label's slug (the sitemap drops them).
--  * get_team_detail (pinned, full body) reads the whole franchise and names
--    the PRIMARY name as canonical, so a historic label's URL 308s to the
--    current page through the layout's existing canonical-slug redirect
--    (/team/oakland-raiders → /team/las-vegas-raiders), the branding lookup
--    keys on the primary name, and the hub (get_franchise_hub → get_team_detail
--    per collection) sums every era.
--  * get_team_players / _top_editions / _activity / _sets / _squeeze /
--    _checklist / _checklist_progress: one guarded splice each — the label
--    predicate becomes `= ANY (team_franchise_slugs(…))`; the anchor is
--    asserted to occur exactly once per function, from the live definition.
--  * resolve_team_name's note now says the reads cover every era (re-pinned).
--
-- Revert: DROP the three helpers; re-apply get_team_detail from
-- 20260801231400 and resolve_team_name from 20260926021808; the seven spliced
-- functions: replace `= ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))))`
-- with `= p_team_slug` (the splice below, inverted).

-- anon-exec: intentional — team_franchise_slugs is a helper of the SECURITY DEFINER team RPCs; service_role may also call it
CREATE OR REPLACE FUNCTION public.team_franchise_slugs(p_collection_id uuid, p_team_slug text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- The site slugs of every label of the franchise p_team_slug names. Keyed from
-- the REGISTRIES only (league_team_abbr — historic names, the WNBA arm — else
-- teams_master), never from editions: the callers put the result in an index
-- condition (`slug_expr = ANY (…)`), so this must cost milliseconds, and a
-- label no registry knows is its own franchise (the slug comes back alone).
-- The list may name a label no edition carries (Tennessee Oilers); harmless in
-- a predicate. Accent-tolerant on input (atletico-de-madrid finds Atlético).
DECLARE
  v_coll  text;
  v_maps  text[];
  v_tm    text;
  v_out   text[];
BEGIN
  IF p_collection_id IS NULL OR p_team_slug IS NULL OR p_team_slug = '' THEN
    RETURN ARRAY[COALESCE(p_team_slug, '')];
  END IF;
  SELECT c.slug INTO v_coll FROM public.collections c WHERE c.id = p_collection_id;
  v_maps := CASE v_coll WHEN 'nfl_all_day' THEN ARRAY['nfl'] WHEN 'nba_top_shot' THEN ARRAY['nba', 'wnba'] END;
  v_tm   := CASE v_coll WHEN 'nfl_all_day' THEN 'NFL' WHEN 'nba_top_shot' THEN 'NBA' WHEN 'laliga_golazos' THEN 'LALIGA' END;

  WITH names AS (
    -- the league map(s), first map wins for a name in both (nba before wnba)
    SELECT a.team_name, 'map:' || m.lg || ':' || a.abbr AS fkey, m.ord::int AS ord
      FROM unnest(COALESCE(v_maps, '{}'::text[])) WITH ORDINALITY AS m(lg, ord)
      CROSS JOIN LATERAL public.league_team_abbr(m.lg) a
    UNION ALL
    -- teams_master, namespaced by league (the Mystics' WAS must not fold into the Wizards' WAS)
    SELECT t.team_name, 'tm:' || t.league::text || ':' || t.abbreviation, 100
      FROM public.teams_master t
     WHERE t.league::text = ANY (ARRAY[v_tm, 'WNBA'])
  ),
  keyed AS (
    SELECT DISTINCT ON (n.team_name) n.team_name, n.fkey,
           regexp_replace(lower(trim(n.team_name)), '[^a-z0-9]+', '-', 'g') AS slug,
           regexp_replace(lower(trim(extensions.unaccent(n.team_name))), '[^a-z0-9]+', '-', 'g') AS uslug
      FROM names n
     ORDER BY n.team_name, n.ord
  ),
  hit AS (
    SELECT k.fkey FROM keyed k
     WHERE k.slug = p_team_slug OR k.uslug = p_team_slug
     ORDER BY (k.slug = p_team_slug) DESC LIMIT 1
  )
  SELECT array_agg(DISTINCT k.slug) INTO v_out
    FROM keyed k JOIN hit h ON h.fkey = k.fkey;
  RETURN COALESCE(v_out, ARRAY[p_team_slug]);
END
$function$;
REVOKE ALL ON FUNCTION public.team_franchise_slugs(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_franchise_slugs(uuid, text) TO service_role;

-- anon-exec: intentional — team_franchise_primary_name is a helper of the SECURITY DEFINER team RPCs; service_role may also call it
CREATE OR REPLACE FUNCTION public.team_franchise_primary_name(p_collection_id uuid, p_team_slug text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- The franchise's CURRENT name: a teams_master row of the collection's league
-- (WNBA included for Top Shot) whose slug is in the franchise, else the
-- most-minted label the collection's editions carry, else NULL (no such team).
-- plpgsql on purpose: a SQL body inlines into its caller and the planner then
-- re-evaluates team_franchise_slugs per scanned row (a 57014 on first apply).
DECLARE
  v_slugs text[];
  v_coll  text;
  v_tm    text;
  v_name  text;
BEGIN
  v_slugs := public.team_franchise_slugs(p_collection_id, p_team_slug);
  SELECT c.slug INTO v_coll FROM public.collections c WHERE c.id = p_collection_id;
  v_tm := CASE v_coll WHEN 'nfl_all_day' THEN 'NFL' WHEN 'nba_top_shot' THEN 'NBA' WHEN 'laliga_golazos' THEN 'LALIGA' END;

  SELECT t.team_name INTO v_name
    FROM public.teams_master t
   WHERE t.league::text = ANY (ARRAY[v_tm, 'WNBA'])
     AND regexp_replace(lower(trim(t.team_name)), '[^a-z0-9]+', '-', 'g') = ANY (v_slugs)
   ORDER BY t.team_name
   LIMIT 1;
  IF v_name IS NOT NULL THEN RETURN v_name; END IF;

  SELECT e.team_name INTO v_name
    FROM public.editions e
   WHERE e.collection_id = p_collection_id AND e.team_name IS NOT NULL
     AND regexp_replace(lower(trim(e.team_name)), '[^a-z0-9]+', '-', 'g') = ANY (v_slugs)
   GROUP BY e.team_name
   ORDER BY count(*) DESC, e.team_name
   LIMIT 1;
  RETURN v_name;
END
$function$;
REVOKE ALL ON FUNCTION public.team_franchise_primary_name(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_franchise_primary_name(uuid, text) TO service_role;

-- anon-exec: intentional — team_historic_slugs is read by the sitemap builder as service_role
CREATE OR REPLACE FUNCTION public.team_historic_slugs(p_collection_id uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Every team label of the collection whose franchise has a DIFFERENT primary
-- name: the slugs the sitemap must not list (they 308 to the primary page).
-- One primary_name call per distinct label (tens per collection).
DECLARE
  r      record;
  v_out  text[] := '{}';
BEGIN
  FOR r IN
    SELECT DISTINCT e.team_name,
           regexp_replace(lower(trim(e.team_name)), '[^a-z0-9]+', '-', 'g') AS slug
      FROM public.editions e
     WHERE e.collection_id = p_collection_id AND e.team_name IS NOT NULL AND trim(e.team_name) <> ''
     ORDER BY 2
  LOOP
    IF public.team_franchise_primary_name(p_collection_id, r.slug) IS DISTINCT FROM r.team_name THEN
      v_out := v_out || r.slug;
    END IF;
  END LOOP;
  RETURN v_out;
END
$function$;
REVOKE ALL ON FUNCTION public.team_historic_slugs(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_historic_slugs(uuid) TO service_role;

-- anon-exec: intentional — full-body write of get_team_detail (pinned); its ACL is unchanged by CREATE OR REPLACE
CREATE OR REPLACE FUNCTION public.get_team_detail(p_collection_id uuid, p_team_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_team_variants text[];
  v_team_canonical text;
  v_collection_slug text;
  v_player_count int;
  v_edition_count int;
  v_total_circulation int;
  v_fmv_total numeric;
  v_floor_total numeric;
  -- Team Hub Phase 1: branding (teams_master) + 30d activity. NULL for Pinnacle.
  v_primary_color text;
  v_secondary_color text;
  v_abbreviation text;
  v_team_external_id text;
  v_league text;
  v_sales_30d int;
  v_volume_30d numeric;
  -- Team Hub Phase 4 (F1a): teams_master short slug, the follow-write key.
  v_team_short_slug text;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  IF p_collection_id = v_pinnacle_uuid THEN
    SELECT array_agg(DISTINCT franchise),
           (array_agg(franchise ORDER BY franchise))[1]
    INTO v_team_variants, v_team_canonical
    FROM pinnacle_editions
    WHERE franchise IS NOT NULL
      AND regexp_replace(lower(trim(franchise)), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    -- Fallback: accept the diacritic-stripped slug the frontend emits.
    IF v_team_variants IS NULL THEN
      SELECT array_agg(DISTINCT franchise),
             (array_agg(franchise ORDER BY franchise))[1]
      INTO v_team_variants, v_team_canonical
      FROM pinnacle_editions
      WHERE franchise IS NOT NULL
        AND regexp_replace(lower(trim(extensions.unaccent(franchise))), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    END IF;

    IF v_team_variants IS NULL THEN RETURN NULL; END IF;

    -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
    SELECT
      COUNT(DISTINCT pe.character_name),
      COUNT(*),
      SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
      SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0)
    INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.franchise = ANY(v_team_variants);
    -- Pinnacle: no teams_master branding, no sports sales activity. Leave NULL.
  ELSE
    -- 2026-09-25 (batch 62): the WHOLE franchise — every label it minted under
    -- (Las Vegas + Oakland + Los Angeles Raiders) — and the canonical name is
    -- the franchise's primary (current) name, so a historic label's URL 308s
    -- to the current page through the layout's canonical-slug redirect.
    SELECT array_agg(DISTINCT team_name)
    INTO v_team_variants
    FROM editions
    WHERE collection_id = p_collection_id
      AND team_name IS NOT NULL
      AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));
    -- (ARRAY(SELECT …) is an InitPlan: the helper runs ONCE, never per scanned row)
    v_team_canonical := public.team_franchise_primary_name(p_collection_id, p_team_slug);

    -- Fallback: accept the diacritic-stripped slug the frontend emits
    -- (e.g. atletico-de-madrid for "Atletico de Madrid"). Runs only on a
    -- would-be 404, so the functional index still serves the hot path.
    IF v_team_variants IS NULL THEN
      SELECT array_agg(DISTINCT team_name),
             (array_agg(team_name ORDER BY team_name))[1]
      INTO v_team_variants, v_team_canonical
      FROM editions
      WHERE collection_id = p_collection_id
        AND team_name IS NOT NULL
        AND regexp_replace(lower(trim(extensions.unaccent(team_name))), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    END IF;

    IF v_team_variants IS NULL THEN RETURN NULL; END IF;

    SELECT
      COUNT(DISTINCT regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g'))
        FILTER (WHERE e.player_name IS NOT NULL AND e.player_name <> ''),
      COUNT(*),
      SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0)
    INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants);

    -- Branding: single indexed lookup on slugified team_name (no cross-league
    -- slug collisions verified among active rows, so no league guard needed).
    SELECT tm.slug, tm.primary_color, tm.secondary_color, tm.abbreviation, tm.external_id, tm.league::text
    INTO v_team_short_slug, v_primary_color, v_secondary_color, v_abbreviation, v_team_external_id, v_league
    FROM teams_master tm
    WHERE tm.active
      AND regexp_replace(lower(trim(tm.team_name)), '[^a-z0-9]+', '-', 'g')
          = regexp_replace(lower(trim(COALESCE(v_team_canonical, ''))), '[^a-z0-9]+', '-', 'g')
    LIMIT 1;

    -- 30d activity: bounded by the team's editions via edition_id join. The
    -- s.collection_id = p_collection_id predicate (authoritative, equal to
    -- e.collection_id via the join) lets the planner use the sales
    -- (collection_id, sold_at DESC) partition index instead of scanning the
    -- whole recent slice -> keeps the fn under its 8s cap for big TS franchises.
    SELECT COUNT(*), COALESCE(SUM(s.price_usd), 0)
    INTO v_sales_30d, v_volume_30d
    FROM sales s
    JOIN editions e ON e.id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants)
      AND s.sold_at >= now() - interval '30 days';
  END IF;

  RETURN jsonb_build_object(
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'team_slug',         p_team_slug,
    'team_name',         v_team_canonical,
    'team_name_variants',v_team_variants,
    'is_franchise',      p_collection_id = v_pinnacle_uuid,
    'player_count',      v_player_count,
    'edition_count',     v_edition_count,
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'primary_color',     v_primary_color,
    'secondary_color',   v_secondary_color,
    'abbreviation',      v_abbreviation,
    'team_external_id',  v_team_external_id,
    'league',            v_league,
    'team_short_slug',   v_team_short_slug,
    'sales_30d',         v_sales_30d,
    'volume_30d_usd',    v_volume_30d
  );
END;
$function$;


-- The seven section RPCs: one guarded splice each, from the LIVE definition.
DO $$
DECLARE
  fn     text;
  def    text;
  n      int;
  anchor text := 'AND regexp_replace(lower(trim(team_name)), ''[^a-z0-9]+'', ''-'', ''g'') = p_team_slug;';
  repl   text := 'AND regexp_replace(lower(trim(team_name)), ''[^a-z0-9]+'', ''-'', ''g'') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));  -- 2026-09-25 (batch 62): the whole franchise, historic labels included; ARRAY(SELECT …) is an InitPlan (the helper runs once)';
BEGIN
  FOREACH fn IN ARRAY ARRAY['get_team_players', 'get_team_top_editions', 'get_team_activity', 'get_team_sets', 'get_team_squeeze', 'get_team_checklist', 'get_team_checklist_progress'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO def
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = fn
       AND pg_get_function_identity_arguments(p.oid) LIKE 'p_collection_id uuid, p_team_slug text%';
    IF def IS NULL THEN RAISE EXCEPTION 'batch 62: % not found', fn; END IF;
    n := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
    IF n <> 1 THEN RAISE EXCEPTION 'batch 62: % — anchor occurs % times, want 1', fn, n; END IF;
    EXECUTE replace(def, anchor, repl);
    RAISE NOTICE 'batch 62: % spliced', fn;
  END LOOP;
END $$;

-- anon-exec: intentional — full-body write of resolve_team_name (pinned; its note changes); ACL unchanged
CREATE OR REPLACE FUNCTION public.resolve_team_name(p_collection_id uuid, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll   text;
  v_maps   text[]; -- league_team_abbr arguments (nfl | nba + wnba), NULL when the collection has no map
  v_tm     text;   -- teams_master.league
  v_q      text;
  v_fr     jsonb;
  v_n      int;
BEGIN
  IF p_collection_id IS NULL OR p_name IS NULL OR trim(p_name) = '' THEN
    RETURN jsonb_build_object('status', 'none', 'query', p_name, 'reason', 'empty name');
  END IF;
  SELECT c.slug INTO v_coll FROM public.collections c WHERE c.id = p_collection_id;
  v_maps := CASE v_coll WHEN 'nfl_all_day' THEN ARRAY['nfl'] WHEN 'nba_top_shot' THEN ARRAY['nba', 'wnba'] END;
  v_tm     := CASE v_coll WHEN 'nfl_all_day' THEN 'NFL' WHEN 'nba_top_shot' THEN 'NBA' WHEN 'laliga_golazos' THEN 'LALIGA' END;
  v_q := '%' || trim(p_name) || '%';

  WITH labels AS (
    -- every team label of the collection, so a matched franchise expands to ALL its names
    SELECT e.team_name, count(*)::int AS editions
      FROM public.editions e
     WHERE e.collection_id = p_collection_id
       AND e.team_name IS NOT NULL AND trim(e.team_name) <> ''
     GROUP BY e.team_name
  ),
  keyed AS (
    SELECT l.team_name, l.editions,
           -- the franchise key: the league map's abbreviation (historic names
           -- included), else teams_master's namespaced by league (the Mystics'
           -- WAS must not fold into the Wizards' WAS), else the label itself
           COALESCE(
             (SELECT 'map:' || m.lg || ':' || a.abbr
                FROM unnest(COALESCE(v_maps, '{}'::text[])) WITH ORDINALITY AS m(lg, ord)
                CROSS JOIN LATERAL public.league_team_abbr(m.lg) a
               WHERE a.team_name = l.team_name ORDER BY m.ord LIMIT 1),
             (SELECT 'tm:' || t.league::text || ':' || t.abbreviation FROM public.teams_master t
               WHERE t.team_name = l.team_name AND t.league::text = ANY (ARRAY[v_tm, 'WNBA']) LIMIT 1),
             'label:' || l.team_name) AS fkey,
           EXISTS (SELECT 1 FROM public.teams_master t
                    WHERE t.team_name = l.team_name AND t.league::text = ANY (ARRAY[v_tm, 'WNBA'])) AS is_current,
           (l.team_name ILIKE v_q) AS matched
      FROM labels l
  ),
  fr AS (
    SELECT k.fkey,
           (SELECT k2.team_name FROM keyed k2 WHERE k2.fkey = k.fkey AND k2.is_current ORDER BY k2.editions DESC LIMIT 1) AS current_name,
           sum(k.editions)::int AS total_editions,
           jsonb_agg(jsonb_build_object('team_name', k.team_name, 'editions', k.editions, 'current', k.is_current)
                     ORDER BY k.is_current DESC, k.editions DESC) AS names
      FROM keyed k
     WHERE k.fkey IN (SELECT m.fkey FROM keyed m WHERE m.matched)
     GROUP BY k.fkey
  )
  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object(
           'franchise', regexp_replace(f.fkey, '^(map:[a-z]+|tm:[A-Z]+|label):', ''),
           'current_name', f.current_name,
           -- the name to query the per-team RPCs with: the current one, else the most-minted label
           'primary_name', COALESCE(f.current_name, (f.names->0->>'team_name')),
           'total_editions', f.total_editions,
           'names', f.names,
           'historic_names', (SELECT COALESCE(jsonb_agg(n) , '[]'::jsonb) FROM jsonb_array_elements(f.names) n
                               WHERE n->>'team_name' IS DISTINCT FROM COALESCE(f.current_name, (f.names->0->>'team_name')))
         ) ORDER BY f.total_editions DESC), '[]'::jsonb)
    INTO v_n, v_fr
    FROM fr f;

  IF v_n = 0 THEN
    RETURN jsonb_build_object('status', 'none', 'query', p_name, 'note', 'No team label in this collection matches. Do not substitute another team.');
  END IF;
  IF v_n = 1 THEN
    RETURN jsonb_build_object('status', 'one', 'query', p_name)
           || (v_fr->0)
           || CASE WHEN jsonb_array_length(v_fr->0->'historic_names') > 0
                   THEN jsonb_build_object('note', 'This franchise has minted under more than one name; the team reads cover EVERY era (historic labels included) — the historic_names list says which labels and how many editions each carries.')
                   ELSE '{}'::jsonb END;
  END IF;
  -- an exact label match among several franchises decides ("Hornets" → Charlotte, not New Orleans, only when typed exactly)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_fr) f WHERE lower(f->>'primary_name') = lower(trim(p_name))) THEN
    SELECT f INTO v_fr FROM jsonb_array_elements(v_fr) f WHERE lower(f->>'primary_name') = lower(trim(p_name)) LIMIT 1;
    RETURN jsonb_build_object('status', 'one', 'query', p_name) || v_fr;
  END IF;
  RETURN jsonb_build_object('status', 'ambiguous', 'query', p_name, 'franchises', v_fr,
                            'note', 'Several franchises match — ask which one, then call again with its primary_name.');
END
$function$;

-- Post-conditions on the live catalog
DO $$
DECLARE d jsonb; r jsonb; s text[];
BEGIN
  s := public.team_franchise_slugs('dee28451-5d62-409e-a1ad-a83f763ac070', 'las-vegas-raiders');
  IF NOT (s @> ARRAY['las-vegas-raiders', 'oakland-raiders', 'los-angeles-raiders']) THEN RAISE EXCEPTION 'slugs: %', s; END IF;
  IF public.team_franchise_primary_name('dee28451-5d62-409e-a1ad-a83f763ac070', 'oakland-raiders') <> 'Las Vegas Raiders' THEN
    RAISE EXCEPTION 'primary: %', public.team_franchise_primary_name('dee28451-5d62-409e-a1ad-a83f763ac070', 'oakland-raiders'); END IF;
  d := public.get_team_detail('dee28451-5d62-409e-a1ad-a83f763ac070', 'las-vegas-raiders');
  IF (d->>'edition_count')::int < 140 OR d->>'team_name' <> 'Las Vegas Raiders' THEN RAISE EXCEPTION 'detail LV: %', d; END IF;
  d := public.get_team_detail('dee28451-5d62-409e-a1ad-a83f763ac070', 'oakland-raiders');
  IF d->>'team_name' <> 'Las Vegas Raiders' THEN RAISE EXCEPTION 'detail Oakland canonical: %', d->>'team_name'; END IF;
  -- the Mystics stay their own franchise
  d := public.get_team_detail('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'washington-mystics');
  IF d->>'team_name' <> 'Washington Mystics' THEN RAISE EXCEPTION 'Mystics folded: %', d->>'team_name'; END IF;
  -- a section RPC sees the historic era
  IF jsonb_array_length(public.get_team_top_editions('dee28451-5d62-409e-a1ad-a83f763ac070', 'las-vegas-raiders', 200, 0)) < 130 THEN
    RAISE EXCEPTION 'top editions do not include the historic eras'; END IF;
  IF NOT ('oakland-raiders' = ANY (public.team_historic_slugs('dee28451-5d62-409e-a1ad-a83f763ac070'))) THEN RAISE EXCEPTION 'historic slugs'; END IF;
  r := public.resolve_team_name('dee28451-5d62-409e-a1ad-a83f763ac070', 'Raiders');
  IF (r->>'note') NOT LIKE '%EVERY era%' THEN RAISE EXCEPTION 'note: %', r->>'note'; END IF;
END $$;
