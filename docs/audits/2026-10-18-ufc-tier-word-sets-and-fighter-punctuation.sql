-- 2026-10-18 ~9:00 AM PT (Cowork cloud; Trevor "Do it all").
-- Follow-up to 20261018153214 (UFC catalogue names from the chain). The two items
-- that pass deferred, now done:
--
-- (A) 147 UFC editions sat in a SET named after a TIER word (set_id -> "Contender",
--     "Challenger" or "Fandom"; 144 also carried that word as set_name, 3 Ultimate
--     Fighter editions carried their real name on a Contender set_id): the April
--     ingest put the tier where the set goes.
--     Their real set is in public.ufc_chain_set_editions (the on-chain set name):
--     fight moments "FIGHTER | EVENT | TYPE" -> set "<EVENT as on chain> <TYPE upper>",
--     punctuation to spaces (the convention every other UFC set already uses: "UFC 202
--     KO TKO", "The Ultimate Fighter Season 16 Finale KO TKO"); catchphrase moments ->
--     the phrase. 26 of the 128 target sets already exist and are reused; 102 are created.
--     The three tier-word sets are then EMPTY (backed up first; only
--     editions.set_id references sets, and no other table holds their ids or slugs —
--     checked 2026-10-18), but are LEFT IN PLACE (see the note at step A's end).
--     The edition's TIER column is untouched.
-- (B) Fighter names lost their punctuation/casing in one copy or the other. The chain
--     spelling wins: Georges St-Pierre, Benoit Saint-Denis, Marc-Andre Barriault,
--     Da'Mon Blackshear, Sean O'Malley; plus Terrance McKinney (players row was
--     "Mckinney"). Then every UFC edition's player_name is set to its player row's name
--     (6 drifted copies: Kai Kara-France x2, Molly McCann, Terrance McKinney,
--     Khalil Rountree Jr., Sean O'Malley). resolve_player_name keys on the
--     unaccented slug, so lookups are unchanged; player external_ids are unchanged.
-- Holdings (wallet_moments_cache) follow editions for every touched edition.
-- BACKUP: rows go into public.audit_20261018_ufc_names_backup with tbl suffixed
-- '_m2' ('editions_m2', 'sets_m2', 'players_m2'). REVERT: re-insert the sets_m2
-- rows, restore editions (set_id, set_name, player_name) and players (name) from
-- the _m2 rows, delete the sets this migration created (their ids are the rows
-- recorded under tbl='sets_m2_created'), then re-run step (4).

DO $$
DECLARE
  c_ufc constant uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023';
  tier_sets constant text[] := ARRAY['Contender','Challenger','Fandom'];
  n int; r record; v_set uuid; v_slug text; v_created int := 0; v_reused int := 0;
BEGIN
  CREATE TEMP TABLE _tw ON COMMIT DROP AS
  SELECT e.id, e.set_id AS old_set,
         CASE WHEN position('|' in c.set_name) > 0
              THEN trim(regexp_replace(regexp_replace(trim(split_part(c.set_name,'|',2))||' '||upper(trim(split_part(c.set_name,'|',3))),'[^A-Za-z0-9 ]',' ','g'),'\s+',' ','g'))
              ELSE c.set_name END AS want
    FROM public.editions e JOIN public.ufc_chain_set_editions c ON c.edition_id = e.id
   WHERE e.collection_id = c_ufc
     AND e.set_id IN (SELECT id FROM public.sets WHERE collection_id = c_ufc AND name = ANY (tier_sets));
  SELECT count(*) INTO n FROM _tw; IF n <> 147 THEN RAISE EXCEPTION 'expected 147 editions on tier-word sets, got %', n; END IF;
  SELECT count(*) INTO n FROM public.editions WHERE collection_id = c_ufc
     AND set_id IN (SELECT id FROM public.sets WHERE collection_id = c_ufc AND name = ANY (tier_sets));
  IF n <> 147 THEN RAISE EXCEPTION 'tier-word-set editions without a chain row: %', n - 147; END IF;

  CREATE TEMP TABLE _pfix(id uuid, new_name text) ON COMMIT DROP;
  INSERT INTO _pfix VALUES
    ('13a8331a-2b4e-42eb-9fad-7f5249f2cdcf','Georges St-Pierre'),
    ('93b67460-30bf-41a8-a712-1f985fc08bab','Benoit Saint-Denis'),
    ('01f0a7d5-457b-4070-8022-e750e1a84bb6','Marc-Andre Barriault'),
    ('7a7bebd5-f05e-462b-8118-28381915a5ce','Da''Mon Blackshear'),
    ('53a13268-8ec5-42ab-9d72-73a9b88d709d','Sean O''Malley');
  INSERT INTO _pfix SELECT id, 'Terrance McKinney' FROM public.players
   WHERE collection_id = c_ufc AND name = 'Terrance Mckinney';
  SELECT count(*) INTO n FROM _pfix p JOIN public.players pl ON pl.id = p.id AND pl.collection_id = c_ufc;
  IF n <> 6 THEN RAISE EXCEPTION 'expected 6 fighter renames, got %', n; END IF;

  -- BACKUP
  INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
  SELECT 'editions_m2', e.id, to_jsonb(e) FROM public.editions e
   WHERE e.collection_id = c_ufc
     AND (e.id IN (SELECT id FROM _tw) OR e.player_id IN (SELECT id FROM _pfix)
          OR e.player_name IS DISTINCT FROM (SELECT name FROM public.players WHERE id = e.player_id));
  INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
  SELECT 'sets_m2', s.id, to_jsonb(s) FROM public.sets s WHERE s.collection_id = c_ufc AND s.name = ANY (tier_sets);
  INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
  SELECT 'players_m2', pl.id, to_jsonb(pl) FROM public.players pl WHERE pl.id IN (SELECT id FROM _pfix);
  SELECT count(*) INTO n FROM public.audit_20261018_ufc_names_backup WHERE tbl = 'sets_m2';
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 tier-word set rows, got %', n; END IF;

  -- (A) repoint every tier-word edition to its chain set, creating the set when absent
  FOR r IN SELECT DISTINCT want FROM _tw ORDER BY want LOOP
    SELECT s.id INTO v_set FROM public.sets s
     WHERE s.collection_id = c_ufc AND upper(s.name) = upper(r.want) AND NOT (s.name = ANY (tier_sets))
     ORDER BY s.created_at LIMIT 1;
    IF v_set IS NULL THEN
      v_slug := 'ufc_strike-set-' || lower(trim(both '-' from regexp_replace(r.want,'[^A-Za-z0-9]+','-','g')));
      IF EXISTS (SELECT 1 FROM public.sets WHERE external_id = v_slug) THEN RAISE EXCEPTION 'set slug % taken', v_slug; END IF;
      INSERT INTO public.sets(external_id, collection_id, name) VALUES (v_slug, c_ufc, r.want) RETURNING id INTO v_set;
      INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row) VALUES ('sets_m2_created', v_set, jsonb_build_object('external_id', v_slug, 'name', r.want));
      v_created := v_created + 1;
    ELSE
      v_reused := v_reused + 1;
    END IF;
    UPDATE public.editions e SET set_id = v_set, set_name = (SELECT name FROM public.sets WHERE id = v_set), updated_at = now()
     WHERE e.id IN (SELECT id FROM _tw WHERE want = r.want);
  END LOOP;
  IF v_created <> 102 OR v_reused <> 26 THEN RAISE EXCEPTION 'sets created % / reused %, expected 102 / 26', v_created, v_reused; END IF;

  IF EXISTS (SELECT 1 FROM public.editions WHERE set_id IN (SELECT id FROM public.audit_20261018_ufc_names_backup WHERE tbl = 'sets_m2')) THEN
    RAISE EXCEPTION 'a tier-word set still has editions';
  END IF;
  -- The three tier-word sets are now EMPTY. They are NOT deleted here: the Supabase MCP holds any
  -- statement carrying a DELETE, and an empty set lists nowhere (get_ufc_set_progress joins editions).
  -- Removing them is a one-line follow-up: DELETE FROM public.sets WHERE id IN (SELECT id FROM
  -- public.audit_20261018_ufc_names_backup WHERE tbl = 'sets_m2');

  -- (B) fighter names: the chain spelling on the player row, then every edition copy follows its row
  UPDATE public.players pl SET name = p.new_name, updated_at = now() FROM _pfix p WHERE pl.id = p.id;
  UPDATE public.editions e SET player_name = pl.name, updated_at = now()
    FROM public.players pl
   WHERE e.collection_id = c_ufc AND pl.id = e.player_id AND e.player_name IS DISTINCT FROM pl.name;

  -- (4) holdings follow the catalogue
  UPDATE public.wallet_moments_cache w
     SET player_name = e.player_name, set_name = e.set_name
    FROM public.editions e
   WHERE w.collection_id = c_ufc AND e.collection_id = c_ufc AND w.edition_key = e.external_id
     AND e.id IN (SELECT id FROM public.audit_20261018_ufc_names_backup WHERE tbl = 'editions_m2')
     AND (w.player_name IS DISTINCT FROM e.player_name OR w.set_name IS DISTINCT FROM e.set_name);

  -- POST-CONDITIONS
  IF EXISTS (SELECT 1 FROM public.editions WHERE collection_id = c_ufc AND set_name = ANY (tier_sets)) THEN
    RAISE EXCEPTION 'a tier-word set name survived on an edition';
  END IF;
  IF EXISTS (SELECT 1 FROM public.editions e JOIN public.players pl ON pl.id = e.player_id
              WHERE e.collection_id = c_ufc AND e.player_name IS DISTINCT FROM pl.name) THEN
    RAISE EXCEPTION 'an edition player_name still differs from its player row';
  END IF;
END $$;

-- ============================================================================
-- (C) 2026-10-18 ~9:00 AM PT, same pass (pg_cron one-off job 748). Found after (A)
-- shipped: 72 UFC editions (all ingested 2026-06-22) carried a correct set_name but
-- set_id NULL, so get_ufc_set_progress (which requires set_id) left them out of every
-- set-completion count. 71 of the 72 names equal the chain-derived name; the 72nd
-- ("UFC 307 GRAPPLING") has no chain row and keeps its name. Link each to the set of
-- that name (24 names exist, case-insensitive, never ambiguous) or create it (43).
-- Backed up as tbl='editions_m3'; created sets as tbl='sets_m3_created'.
-- REVERT: set set_id back to NULL for the editions_m3 ids; remove the sets_m3_created ids.
DO $$
DECLARE
  c_ufc constant uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023';
  n int; r record; v_set uuid; v_slug text; v_created int := 0; v_reused int := 0;
BEGIN
  SELECT count(*) INTO n FROM public.editions WHERE collection_id = c_ufc AND set_id IS NULL;
  IF n <> 72 THEN RAISE EXCEPTION 'expected 72 unlinked editions, got %', n; END IF;
  INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
  SELECT 'editions_m3', e.id, to_jsonb(e) FROM public.editions e WHERE e.collection_id = c_ufc AND e.set_id IS NULL;
  FOR r IN SELECT DISTINCT set_name FROM public.editions WHERE collection_id = c_ufc AND set_id IS NULL ORDER BY 1 LOOP
    SELECT s.id INTO v_set FROM public.sets s WHERE s.collection_id = c_ufc AND upper(s.name) = upper(r.set_name);
    IF v_set IS NULL THEN
      v_slug := 'ufc_strike-set-' || lower(trim(both '-' from regexp_replace(r.set_name,'[^A-Za-z0-9]+','-','g')));
      IF EXISTS (SELECT 1 FROM public.sets WHERE external_id = v_slug) THEN RAISE EXCEPTION 'set slug % taken', v_slug; END IF;
      INSERT INTO public.sets(external_id, collection_id, name) VALUES (v_slug, c_ufc, r.set_name) RETURNING id INTO v_set;
      INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row) VALUES ('sets_m3_created', v_set, jsonb_build_object('external_id', v_slug, 'name', r.set_name));
      v_created := v_created + 1;
    ELSE
      v_reused := v_reused + 1;
    END IF;
    UPDATE public.editions SET set_id = v_set, set_name = (SELECT name FROM public.sets WHERE id = v_set), updated_at = now()
     WHERE collection_id = c_ufc AND set_id IS NULL AND set_name = r.set_name;
  END LOOP;
  IF v_created <> 43 OR v_reused <> 24 THEN RAISE EXCEPTION 'sets created % / reused %, expected 43 / 24', v_created, v_reused; END IF;
  UPDATE public.wallet_moments_cache w SET set_name = e.set_name
    FROM public.editions e
   WHERE w.collection_id = c_ufc AND e.collection_id = c_ufc AND w.edition_key = e.external_id
     AND e.id IN (SELECT id FROM public.audit_20261018_ufc_names_backup WHERE tbl = 'editions_m3')
     AND w.set_name IS DISTINCT FROM e.set_name;
  IF EXISTS (SELECT 1 FROM public.editions WHERE collection_id = c_ufc AND set_id IS NULL) THEN RAISE EXCEPTION 'an unlinked edition remains'; END IF;
  IF EXISTS (SELECT 1 FROM public.editions e JOIN public.sets s ON s.id = e.set_id WHERE e.collection_id = c_ufc AND e.set_name IS DISTINCT FROM s.name) THEN
    RAISE EXCEPTION 'an edition set_name differs from its set row';
  END IF;
END $$;
