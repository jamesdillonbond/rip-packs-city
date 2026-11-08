-- audit_20261108_team_nicknames_in_search_and_resolver
--
-- #238 (known-issues), 2026-11-08 ~8:30 AM PT (Claude Code, Trevor's Windows box;
-- Trevor: "work through anything unfinished"). Site search and the concierge had
-- no TEAM nicknames: "rip city" returned Thunder/Raptors prose hits, "dubs" two
-- Eric Paschall editions, "niners" / "pats" NOTHING (measured live via
-- rpc_search_catalog before this). The player half closed 11-07
-- (player_name_aliases); this is the franchise half (rule 2: a team label is
-- not a FRANCHISE; a nickname is an ALIAS, never a rename).
--
-- CHANGE
--   1. table team_name_aliases(collection_id, alias_slug, team_name): a nickname
--      points at the LABEL(S) editions carry (several rows when one franchise
--      minted under two labels: Clippers, Chargers). Keyed on the label, not the
--      franchise key the item sketched: both readers already work in labels
--      (search groups by label; resolve_team_name expands a matched label to its
--      whole franchise), so a label key needs no fourth copy of the key logic.
--      alias_slug is the query slugged: lower, runs of non [a-z0-9] -> '-',
--      outer dashes trimmed ("rip city" -> rip-city).
--   2. rpc_search_catalog: new team_alias_hits branch (exact + prefix, so a
--      nickname outranks the prose/substring editions it used to lose to);
--      in-place splice of the LIVE body, as 20261108013704 did.
--   3. resolve_team_name (pinned): a label also matches when the name typed is
--      one of its nicknames. Full body, verbatim from 20260926033639 + that arm.
--   Seeds: one unambiguous nickname per franchise that a collector types and
--   the label does not already contain (celts/blazers/grizz already substring-
--   match). "birds" left out (Larry Bird); "hawks" left out (Seahawks/Hawks).
--
-- anon-exec: unchanged (rpc_search_catalog, resolve_team_name) — CREATE OR REPLACE of existing functions, same signatures; ACLs preserved.
--
-- REVERT: re-apply resolve_team_name from 20260926033639 and the inverse splice
-- of rpc_search_catalog (o/n swapped) FIRST — both read the table — then
-- DROP TABLE public.team_name_aliases.

CREATE TABLE IF NOT EXISTS public.team_name_aliases (
  collection_id uuid NOT NULL REFERENCES public.collections(id),
  alias_slug    text NOT NULL CHECK (alias_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  team_name     text NOT NULL CHECK (btrim(team_name) <> ''),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, alias_slug, team_name)
);
COMMENT ON TABLE public.team_name_aliases IS
  'A NICKNAME for a team label (#238, 2026-11-08): "rip city" -> Portland Trail Blazers. Never a rename. alias_slug = btrim(regexp_replace(lower(trim(q)), ''[^a-z0-9]+'', ''-'', ''g''), ''-''). Read by rpc_search_catalog (team_alias_hits) and resolve_team_name.';
ALTER TABLE public.team_name_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_name_aliases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.team_name_aliases TO service_role;

INSERT INTO public.team_name_aliases (collection_id, alias_slug, team_name) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'rip-city', 'Portland Trail Blazers'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'dubs', 'Golden State Warriors'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'sixers', 'Philadelphia 76ers'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'cavs', 'Cleveland Cavaliers'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'mavs', 'Dallas Mavericks'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'clips', 'LA Clippers'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'clips', 'Los Angeles Clippers'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'pels', 'New Orleans Pelicans'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'niners', 'San Francisco 49ers'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'pats', 'New England Patriots'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'bucs', 'Tampa Bay Buccaneers'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'jags', 'Jacksonville Jaguars'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'bolts', 'Los Angeles Chargers'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'bolts', 'San Diego Chargers')
ON CONFLICT DO NOTHING;

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.rpc_search_catalog(text,uuid,integer)'::regprocedure);
  o1 text := $o$    GROUP BY 1, 2, 3
  ),
  -- Candidates come from the ANCHOR alone$o$;
  n1 text := $n$    GROUP BY 1, 2, 3
  ),
  -- 2026-11-08 (#238): a registered team NICKNAME ("rip city", "niners") finds
  -- its label(s) and ranks as an exact hit. Its own branch, so the
  -- trigram-backed team arm above keeps its index; a label that arm already
  -- found is not listed twice (see unioned).
  team_alias_hits AS (
    SELECT 'team'::text AS k,
      regexp_replace(lower(btrim(e.team_name)), '[^a-z0-9]+', '-', 'g') AS sl,
      e.collection_id AS cid, min(e.team_name) AS lbl, count(*)::int AS n,
      NULL::text AS thumb,
      max(extensions.similarity(lower(e.team_name), v_q)) AS sim,
      true AS exact,
      true AS prefix
    FROM public.team_name_aliases ta
    JOIN public.editions e
      ON e.collection_id = ta.collection_id AND e.team_name = ta.team_name
    WHERE ta.alias_slug = btrim(regexp_replace(v_qa, '[^a-z0-9]+', '-', 'g'), '-')
      AND (p_collection_id IS NULL OR ta.collection_id = p_collection_id)
      AND (e.collection_id <> v_ts OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
    GROUP BY 1, 2, 3
  ),
  -- Candidates come from the ANCHOR alone$n$;
  o2 text := $o$           0.20::real, 1.0::numeric FROM team_hits
$o$;
  n2 text := $n$           0.20::real, 1.0::numeric FROM team_hits
     WHERE NOT EXISTS (SELECT 1 FROM team_alias_hits th
                        WHERE th.cid = team_hits.cid AND th.sl = team_hits.sl)
    UNION ALL
    SELECT k, lbl, NULL::text, sl, cid, thumb, n, sim, exact, prefix,
           0.20::real, 1.0::numeric FROM team_alias_hits
$n$;
  v_hits int;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, o1, ''))) / length(o1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'team arm end found % times, want 1', v_hits; END IF;
  v_hits := (length(v_def) - length(replace(v_def, o2, ''))) / length(o2);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'team union line found % times, want 1', v_hits; END IF;
  v_def := replace(replace(v_def, o1, n1), o2, n2);
  EXECUTE v_def;
END
$mig$;

-- anon-exec: unchanged (resolve_team_name) — full-body write of the pinned function; ACL preserved by CREATE OR REPLACE
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
           (l.team_name ILIKE v_q
            -- 2026-11-08 (#238): or the name typed IS a registered nickname of
            -- this label ("dubs", "niners"); the franchise then expands as usual
            OR EXISTS (SELECT 1 FROM public.team_name_aliases ta
                        WHERE ta.collection_id = p_collection_id
                          AND ta.team_name = l.team_name
                          AND ta.alias_slug = btrim(regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g'), '-'))) AS matched
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
