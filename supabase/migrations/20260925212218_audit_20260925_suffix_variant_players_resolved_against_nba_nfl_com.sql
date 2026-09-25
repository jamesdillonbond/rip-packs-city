-- 2026-09-25 (PT) — #139: the 37 suffix-variant player pairs (Jr. / Sr. / II /
-- III / IV), resolved against NBA.com and NFL.com and applied.
--
-- WHY. "mahomes" returned two All Day players; Courtney-Lee-style tiles aside,
-- 37 pairs in `players` differed only by a generational suffix. The same shape
-- hides two different things, so no rule could act on it:
--   • two PEOPLE (father / son): Gary Payton / II, Tim Hardaway / Jr., Larry
--     Nance / Jr., Kenyon Martin / KJ, Ron Harper / Jr., Glenn Robinson / III on
--     Top Shot (all keyed by distinct NBA person ids); Antoine Winfield (Bills,
--     1999) / Jr., Asante Samuel (Patriots, 2006) / Jr. on All Day;
--   • ONE person spelled two ways by the source: Top Shot's per-play fossil
--     rows ("Jimmy Butler III" flow:6404 beside 202710, "GG Jackson II"
--     flow:6445, "Lonnie Walker" flow:42, "Marcus Morris Sr." flow:1951, the
--     slug-keyed "Kevin Knox"), and All Day, which labelled suffixed players
--     without the suffix from series 7 on (Patrick Mahomes II → Patrick Mahomes,
--     Kenneth Walker III → Kenneth Walker, … 20 pairs);
--   • MIXED rows: All Day's "Marvin Harrison" holds the Colts father's legends
--     moments (game dates 2004–2008) AND the Cardinals son's rookie moments
--     (2024–2025); "Joey Porter" holds the 1999-draft father's two moments AND
--     the son's 2024-10-06 interception. Edition-level, not row-level.
--
-- The canonical spelling is the league's own site, read 2026-09-25 ~2:05 PM PT:
-- NBA.com DISPLAY_FIRST_LAST for the NBA person id (Jimmy Butler III, GG
-- Jackson, Kevin Knox II, Lonnie Walker IV, Marcus Morris Sr., KJ Martin) and the
-- NFL.com player-page title for All Day (Patrick Mahomes, Marvin Harrison Jr.,
-- Kenneth Walker III, Brian Thomas Jr., Pat Surtain II, Byron Murphy II, …).
-- Every other spelling becomes a player_name_aliases row (the 20260925135939
-- table): resolve_canonical_player / ensure_players_from_edition_names stop
-- re-minting it, link_editions_to_players_by_name links through it, and the
-- player layout 308s the old URL to the canonical page. Edition labels
-- (editions.player_name) are NOT rewritten — they are the collectible's own text
-- and search's token match keeps finding them.
--
-- One deliberate exception: NFL.com titles the Cardinals/Vikings CB "Byron
-- Murphy" and the Seahawks DT "Byron Murphy II". All Day labels the CB "Byron
-- Murphy Jr." and the DT "Byron Murphy"; renaming the CB to NFL.com's bare name
-- would collide with the DT's alias. The CB keeps "Byron Murphy Jr."; the DT
-- becomes "Byron Murphy II" with alias 'byron-murphy'.
--
-- Backups (RLS on): audit_20260925_suffix_players_backup (every deleted row),
-- audit_20260925_suffix_editions_backup (edition_id, old player_id, old name of
-- the row) — covers the merges AND the two edition-level splits.
-- Revert: INSERT the players back from the first; UPDATE editions e SET
-- player_id = b.player_id FROM audit_20260925_suffix_editions_backup b WHERE
-- b.edition_id = e.id; UPDATE players SET name = b.old_name FROM
-- audit_20260925_suffix_renames_backup b WHERE b.player_id = players.id; DELETE
-- FROM player_name_aliases WHERE note LIKE '#139%'.

CREATE TABLE IF NOT EXISTS public.audit_20260925_suffix_players_backup AS
  SELECT p.*, now() AS backed_up_at FROM public.players p WHERE false;
ALTER TABLE public.audit_20260925_suffix_players_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_suffix_players_backup FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS public.audit_20260925_suffix_editions_backup (
  edition_id uuid PRIMARY KEY,
  player_id  uuid NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260925_suffix_editions_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_suffix_editions_backup FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS public.audit_20260925_suffix_renames_backup (
  player_id uuid PRIMARY KEY,
  old_name  text NOT NULL,
  new_name  text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260925_suffix_renames_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_suffix_renames_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_ts   CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_ad   CONSTANT uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_ufc  CONSTANT uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023';
  r       RECORD;
  v_keep  uuid;
  v_drop  uuid;
  v_moved int;
  v_slug_old text;
  v_slug_drop text;
  v_slug_new text;
  v_merged int := 0;
BEGIN
  -- (collection, row to KEEP as it is named today, row to DROP, canonical name)
  CREATE TEMP TABLE _pairs (collection_id uuid, keep_name text, drop_name text, canonical text) ON COMMIT DROP;
  INSERT INTO _pairs VALUES
    -- Top Shot: keep the NBA-person-id row; the fossil/slug row goes.
    (v_ts, 'Jimmy Butler',        'Jimmy Butler III',    'Jimmy Butler III'),
    (v_ts, 'GG Jackson',          'GG Jackson II',       'GG Jackson'),
    (v_ts, 'Kevin Knox II',       'Kevin Knox',          'Kevin Knox II'),
    (v_ts, 'Lonnie Walker IV',    'Lonnie Walker',       'Lonnie Walker IV'),
    (v_ts, 'Marcus Morris',       'Marcus Morris Sr.',   'Marcus Morris Sr.'),
    -- All Day: keep the row already spelled the NFL.com way where one exists.
    (v_ad, 'Patrick Mahomes',     'Patrick Mahomes II',  'Patrick Mahomes'),
    (v_ad, 'Allen Robinson',      'Allen Robinson II',   'Allen Robinson'),
    (v_ad, 'Brian Robinson',      'Brian Robinson Jr.',  'Brian Robinson'),
    (v_ad, 'Brian Thomas Jr.',    'Brian Thomas',        'Brian Thomas Jr.'),
    (v_ad, 'Darius Slay',         'Darius Slay Jr.',     'Darius Slay'),
    (v_ad, 'Derek Stingley Jr.',  'Derek Stingley',      'Derek Stingley Jr.'),
    (v_ad, 'Derwin James',        'Derwin James Jr.',    'Derwin James'),
    (v_ad, 'Dexter Lawrence',     'Dexter Lawrence II',  'Dexter Lawrence'),
    (v_ad, 'Gardner Minshew',     'Gardner Minshew II',  'Gardner Minshew'),
    (v_ad, 'Greg Newsome II',     'Greg Newsome',        'Greg Newsome II'),
    (v_ad, 'Ivan Pace Jr.',       'Ivan Pace',           'Ivan Pace Jr.'),
    (v_ad, 'James Bradberry',     'James Bradberry IV',  'James Bradberry'),
    (v_ad, 'James Pearce Jr.',    'James Pearce',        'James Pearce Jr.'),
    (v_ad, 'Kenneth Walker III',  'Kenneth Walker',      'Kenneth Walker III'),
    (v_ad, 'Kenny Moore II',      'Kenny Moore',         'Kenny Moore II'),
    (v_ad, 'Marvin Mims Jr.',     'Marvin Mims',         'Marvin Mims Jr.'),
    (v_ad, 'Michael Penix Jr.',   'Michael Penix',       'Michael Penix Jr.'),
    (v_ad, 'Pat Surtain II',      'Pat Surtain',         'Pat Surtain II'),
    (v_ad, 'Travis Etienne',      'Travis Etienne Jr.',  'Travis Etienne'),
    (v_ad, 'Will Anderson Jr.',   'Will Anderson',       'Will Anderson Jr.'),
    -- UFC: punctuation only; both slugs were already identical.
    (v_ufc, 'Khalil Rountree Jr.', 'Khalil Rountree Jr', 'Khalil Rountree Jr.');

  FOR r IN SELECT * FROM _pairs LOOP
    SELECT id INTO v_keep FROM public.players WHERE collection_id = r.collection_id AND name = r.keep_name;
    SELECT id INTO v_drop FROM public.players WHERE collection_id = r.collection_id AND name = r.drop_name;
    IF v_keep IS NULL THEN
      RAISE EXCEPTION '#139: keep row "%" not found', r.keep_name;
    END IF;
    IF v_drop IS NULL THEN
      RAISE NOTICE '#139: "%" already gone — skipping the merge, still naming/aliasing', r.drop_name;
    ELSE
      IF EXISTS (SELECT 1 FROM public.serial_fmv_pooled_player_effect WHERE player_id = v_drop)
         OR EXISTS (SELECT 1 FROM public.panini_bridge_candidate_editions WHERE player_id = v_drop)
         OR EXISTS (SELECT 1 FROM public.badge_editions WHERE player_id = v_drop::text) THEN
        RAISE EXCEPTION '#139: "%" is referenced outside editions — extend the merge first', r.drop_name;
      END IF;
      INSERT INTO public.audit_20260925_suffix_players_backup SELECT p.*, now() FROM public.players p WHERE p.id = v_drop;
      INSERT INTO public.audit_20260925_suffix_editions_backup (edition_id, player_id)
        SELECT e.id, e.player_id FROM public.editions e WHERE e.player_id = v_drop
        ON CONFLICT (edition_id) DO NOTHING;
      UPDATE public.editions SET player_id = v_keep WHERE player_id = v_drop;
      GET DIAGNOSTICS v_moved = ROW_COUNT;
      DELETE FROM public.players WHERE id = v_drop;
      v_merged := v_merged + 1;
      RAISE NOTICE '#139: merged "%" into "%" (% editions)', r.drop_name, r.keep_name, v_moved;
    END IF;

    v_slug_old  := regexp_replace(lower(trim(extensions.unaccent(r.keep_name))), '[^a-z0-9]+', '-', 'g');
    v_slug_drop := regexp_replace(lower(trim(extensions.unaccent(r.drop_name))), '[^a-z0-9]+', '-', 'g');
    v_slug_new  := regexp_replace(lower(trim(extensions.unaccent(r.canonical))), '[^a-z0-9]+', '-', 'g');

    IF r.canonical <> r.keep_name THEN
      INSERT INTO public.audit_20260925_suffix_renames_backup (player_id, old_name, new_name)
        VALUES (v_keep, r.keep_name, r.canonical) ON CONFLICT (player_id) DO NOTHING;
      UPDATE public.players SET name = r.canonical WHERE id = v_keep;
    END IF;
    -- every non-canonical spelling of this person 308s / resolves to the kept row
    IF v_slug_old <> v_slug_new THEN
      INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
        VALUES (r.collection_id, v_slug_old, v_keep, '#139 2026-09-25: former spelling "' || r.keep_name || '"')
        ON CONFLICT (collection_id, alias_slug) DO NOTHING;
    END IF;
    IF v_slug_drop <> v_slug_new THEN
      INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
        VALUES (r.collection_id, v_slug_drop, v_keep, '#139 2026-09-25: source spelling "' || r.drop_name || '"')
        ON CONFLICT (collection_id, alias_slug) DO NOTHING;
    END IF;
  END LOOP;
  RAISE NOTICE '#139: % rows merged', v_merged;

  -- Renames with no merge (NBA.com / NFL.com spelling; the old slug becomes an alias).
  FOR r IN SELECT * FROM (VALUES
      (v_ts, 'Kenyon Martin Jr.', 'KJ Martin'),
      (v_ad, 'Byron Murphy',      'Byron Murphy II')
    ) v(collection_id, old_name, new_name)
  LOOP
    SELECT id INTO v_keep FROM public.players WHERE collection_id = r.collection_id AND name = r.old_name;
    IF v_keep IS NULL THEN
      RAISE NOTICE '#139: "%" not found for rename — skipping', r.old_name;
      CONTINUE;
    END IF;
    INSERT INTO public.audit_20260925_suffix_renames_backup (player_id, old_name, new_name)
      VALUES (v_keep, r.old_name, r.new_name) ON CONFLICT (player_id) DO NOTHING;
    UPDATE public.players SET name = r.new_name WHERE id = v_keep;
    INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
      VALUES (r.collection_id, regexp_replace(lower(trim(extensions.unaccent(r.old_name))), '[^a-z0-9]+', '-', 'g'), v_keep,
              '#139 2026-09-25: former spelling "' || r.old_name || '"')
      ON CONFLICT (collection_id, alias_slug) DO NOTHING;
  END LOOP;

  -- Edition-level splits (father and son under one bare name).
  -- Marvin Harrison: the Cardinals editions are the son's (game dates 2024–2025;
  -- the three NULL-dated rookie-set editions are Cardinals too).
  SELECT id INTO v_keep FROM public.players WHERE collection_id = v_ad AND name = 'Marvin Harrison Jr.';
  SELECT id INTO v_drop FROM public.players WHERE collection_id = v_ad AND name = 'Marvin Harrison';
  IF v_keep IS NULL OR v_drop IS NULL THEN RAISE EXCEPTION '#139: Marvin Harrison rows not found'; END IF;
  INSERT INTO public.audit_20260925_suffix_editions_backup (edition_id, player_id)
    SELECT e.id, e.player_id FROM public.editions e
     WHERE e.player_id = v_drop AND e.team_name = 'Arizona Cardinals'
    ON CONFLICT (edition_id) DO NOTHING;
  UPDATE public.editions SET player_id = v_keep WHERE player_id = v_drop AND team_name = 'Arizona Cardinals';
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RAISE NOTICE '#139: Marvin Harrison → Jr.: % Cardinals editions', v_moved;

  -- Joey Porter: the 2024-10-06 Stadium interception (external_id 3591) is the son's.
  SELECT id INTO v_keep FROM public.players WHERE collection_id = v_ad AND name = 'Joey Porter Jr.';
  SELECT id INTO v_drop FROM public.players WHERE collection_id = v_ad AND name = 'Joey Porter';
  IF v_keep IS NULL OR v_drop IS NULL THEN RAISE EXCEPTION '#139: Joey Porter rows not found'; END IF;
  INSERT INTO public.audit_20260925_suffix_editions_backup (edition_id, player_id)
    SELECT e.id, e.player_id FROM public.editions e
     WHERE e.player_id = v_drop AND e.collection_id = v_ad AND e.external_id = '3591' AND e.game_date >= DATE '2020-01-01'
    ON CONFLICT (edition_id) DO NOTHING;
  UPDATE public.editions SET player_id = v_keep
   WHERE player_id = v_drop AND collection_id = v_ad AND external_id = '3591' AND game_date >= DATE '2020-01-01';
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RAISE NOTICE '#139: Joey Porter → Jr.: % edition', v_moved;
END $$;

-- Post-conditions.
DO $$
DECLARE v_n int; v_ts CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd'; v_ad CONSTANT uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
BEGIN
  -- (1) none of the merged spellings survives as a players row
  SELECT count(*) INTO v_n FROM public.players
   WHERE (collection_id, name) IN (
     (v_ts,'Jimmy Butler'), (v_ts,'GG Jackson II'), (v_ts,'Kevin Knox'), (v_ts,'Lonnie Walker'), (v_ts,'Marcus Morris'), (v_ts,'Kenyon Martin Jr.'),
     (v_ad,'Patrick Mahomes II'), (v_ad,'Allen Robinson II'), (v_ad,'Brian Robinson Jr.'), (v_ad,'Brian Thomas'), (v_ad,'Darius Slay Jr.'),
     (v_ad,'Derek Stingley'), (v_ad,'Derwin James Jr.'), (v_ad,'Dexter Lawrence II'), (v_ad,'Gardner Minshew II'), (v_ad,'Greg Newsome'),
     (v_ad,'Ivan Pace'), (v_ad,'James Bradberry IV'), (v_ad,'James Pearce'), (v_ad,'Kenneth Walker'), (v_ad,'Kenny Moore'), (v_ad,'Marvin Mims'),
     (v_ad,'Michael Penix'), (v_ad,'Pat Surtain'), (v_ad,'Travis Etienne Jr.'), (v_ad,'Will Anderson'), (v_ad,'Byron Murphy'));
  IF v_n <> 0 THEN RAISE EXCEPTION '#139: % merged/renamed spellings still exist as rows', v_n; END IF;
  -- (2) the canonical rows exist and every old spelling is an alias to them
  SELECT count(*) INTO v_n FROM public.player_name_aliases WHERE note LIKE '#139%';
  IF v_n < 28 THEN RAISE EXCEPTION '#139: only % alias rows registered (expected ≥ 28)', v_n; END IF;
  IF public.get_player_alias_target(v_ts, 'jimmy-butler') <> 'jimmy-butler-iii' THEN RAISE EXCEPTION '#139: jimmy-butler does not alias to jimmy-butler-iii'; END IF;
  IF public.get_player_alias_target(v_ad, 'patrick-mahomes-ii') <> 'patrick-mahomes' THEN RAISE EXCEPTION '#139: patrick-mahomes-ii does not alias to patrick-mahomes'; END IF;
  -- (3) the father/son rows are untouched and correctly split
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE collection_id = v_ts AND name = 'Gary Payton')
     OR NOT EXISTS (SELECT 1 FROM public.players WHERE collection_id = v_ts AND name = 'Gary Payton II') THEN
    RAISE EXCEPTION '#139: a two-people pair was merged';
  END IF;
  SELECT count(*) INTO v_n FROM public.editions e JOIN public.players p ON p.id = e.player_id
   WHERE p.collection_id = v_ad AND p.name = 'Marvin Harrison' AND e.team_name = 'Arizona Cardinals';
  IF v_n <> 0 THEN RAISE EXCEPTION '#139: % Cardinals editions still on the Colts Marvin Harrison', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.editions e JOIN public.players p ON p.id = e.player_id
   WHERE p.collection_id = v_ad AND p.name = 'Joey Porter' AND e.game_date >= DATE '2020-01-01';
  IF v_n <> 0 THEN RAISE EXCEPTION '#139: % edition(s) from 2024 still sit on the 1999 Joey Porter', v_n; END IF;
  -- (4) nothing left unlinked that the linker could now place
  SELECT count(*) INTO v_n FROM public.editions e WHERE e.player_id IS NULL AND e.collection_id IN (v_ts, v_ad)
     AND e.player_name IN ('Jimmy Butler III','Patrick Mahomes II','Kenneth Walker','Marvin Harrison Jr.');
  IF v_n <> 0 THEN RAISE NOTICE '#139: % editions with a merged label are unlinked — the daily linker will place them through the alias', v_n; END IF;
END $$;
