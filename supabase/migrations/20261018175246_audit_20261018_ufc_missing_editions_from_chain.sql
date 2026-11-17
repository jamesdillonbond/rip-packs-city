-- 2026-10-18 10:52 AM PT (Cowork cloud; Trevor "Keep going").
-- UFC Strike: the catalogue gains the 99 editions it never had, built from the CHAIN.
--
-- WHY: of the 628 on-chain UFC sets, 100 real (non-retired) ones had no RPC edition. 56
-- were in public.ufc_chain_set_editions with edition_id NULL (the 10-04 "47 sets the
-- catalogue lacks" line); 44 were not in that map at all (35 "ORIGIN" 1/1s, eight
-- Ultimate 1/1s, and set 625, KAYLA HARRISON | UFC 307 | GRAPPLING, which DOES exist as
-- an edition and is only linked here). They are mostly the collection's rarest moments
-- (Champion, Ultimate, 1/1 Origin), so the catalogue under-counted exactly where value is.
-- Left out on purpose: 10 retired contract sets ("OLD - ... DO NOT USE", "TO BE BURNED",
-- "BURN", "Error": 165 179 205 213 221 224 260 262 449 464) and 397 EMERALD KEY (a pack
-- insert with no fighter).
--
-- SOURCE: UFC_NFT.getSetMetadata(setId) + getSetMaxEditions(setId) on Flow mainnet, read
-- 2026-10-18 by pg_net (net._http_response 1816550, 1816551). The 100 parsed rows hashed
-- md5 7e0944219a89e7f224221f1431818e54 over id|name|max|preview|image, identical to a
-- local read (docs/audits/2026-10-18-ufc-chain-set-media.json). Tier / series / athlete come
-- from public.ufc_chain_set_metadata (migration 20261018160339).
-- MAPPING (each rule matches how the existing 518 editions are built, verified on set 310):
--   external_id = upper(name), non-alphanumerics -> '-', + '-' + max  (slugifyUfcEdition)
--   set_name    = the parts after the fighter, punctuation -> spaces, the fight type upper
--                 ("UFC 268 KO TKO"; an Origin 1/1 gets "... ORIGIN", its own set, so it never
--                 shares a title with the open edition of the same fight)
--   player      = ufc_chain_set_metadata.athlete_name, matched case-insensitively to an
--                 existing active UFC player, else a new player row
--   thumbnail_url = chain "preview", video_url = chain "image", circulation_count = max,
--   tier = upper(chain TIER), series = chain SERIES, edition_kind 'LE', collection 'ufc_strike'
-- REVERT: the created editions / sets / players are listed in
--   public.audit_20261018_ufc_names_backup under tbl 'editions_m6_created' / 'sets_m6_created' /
--   'players_m6_created' (and the map rows under 'cse_m6'). Null their ufc_chain_set_editions
--   edition_id first, then remove those rows (sales promoted afterwards are logged in
--   flowty_archive.ufc_chain_named_promoted with promoted_at after this migration).

DO $$
DECLARE
  c_ufc constant uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023';
  n int; r record; v_player uuid; v_set uuid; v_ed uuid; v_slug text;
  c_ed int := 0; c_set int := 0; c_pl int := 0; c_link int := 0;
BEGIN
  CREATE TEMP TABLE _m ON COMMIT DROP AS
  WITH resp AS (SELECT content FROM net._http_response WHERE id IN (1816550, 1816551) AND status_code = 200),
  j AS (SELECT convert_from(decode(content::jsonb #>> '{}','base64'),'UTF8')::jsonb j FROM resp),
  s AS (SELECT (e->'key'->>'value')::int set_id, e->'value'->'value' kv FROM j, jsonb_array_elements(j->'value') e)
  SELECT s.set_id, f.m->>'name' AS name, (f.m->>'max')::int AS max_ed, f.m->>'preview' AS preview, f.m->>'image' AS image
    FROM s CROSS JOIN LATERAL (SELECT jsonb_object_agg(k->'key'->>'value', k->'value'->>'value') m FROM jsonb_array_elements(s.kv) k) f;
  SELECT count(*) INTO n FROM _m; IF n <> 100 THEN RAISE EXCEPTION 'expected 100 chain sets, got %', n; END IF;
  IF (SELECT md5(string_agg(concat_ws('|', set_id, name, max_ed, preview, image), E'\n' ORDER BY set_id)) FROM _m)
     <> '7e0944219a89e7f224221f1431818e54' THEN RAISE EXCEPTION 'chain read differs from the verified read'; END IF;

  CREATE TEMP TABLE _w ON COMMIT DROP AS
  SELECT m.*, md.tier, md.series, md.athlete_name,
         regexp_replace(regexp_replace(upper(m.name), '[^A-Z0-9]+', '-', 'g'), '^-+|-+$', '', 'g') || '-' || m.max_ed AS slug,
         trim(regexp_replace(regexp_replace(
           trim(split_part(m.name,'|',2)) || ' ' || upper(trim(split_part(m.name,'|',3)))
           || CASE WHEN split_part(m.name,'|',4) <> '' THEN ' ' || upper(trim(split_part(m.name,'|',4))) ELSE '' END,
           '[^A-Za-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g')) AS set_name
    FROM _m m JOIN public.ufc_chain_set_metadata md ON md.set_id = m.set_id;
  SELECT count(*) INTO n FROM _w; IF n <> 100 THEN RAISE EXCEPTION 'metadata join lost rows: %', n; END IF;
  SELECT count(*) INTO n FROM _w WHERE athlete_name IS NULL OR tier IS NULL OR series IS NULL OR max_ed IS NULL OR max_ed < 1;
  IF n <> 0 THEN RAISE EXCEPTION '% target sets lack athlete/tier/series/max', n; END IF;

  -- backup the map rows we will touch
  INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
  SELECT 'cse_m6', gen_random_uuid(), to_jsonb(c) FROM public.ufc_chain_set_editions c WHERE c.set_id IN (SELECT set_id FROM _w);

  FOR r IN SELECT * FROM _w ORDER BY set_id LOOP
    SELECT e.id INTO v_ed FROM public.editions e WHERE e.collection_id = c_ufc AND upper(e.external_id) = r.slug;
    IF v_ed IS NOT NULL THEN
      -- only set 625 may already exist
      IF r.set_id <> 625 THEN RAISE EXCEPTION 'set % unexpectedly already has edition %', r.set_id, r.slug; END IF;
      INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
      SELECT 'editions_m6_linked', e.id, to_jsonb(e) FROM public.editions e WHERE e.id = v_ed;
      UPDATE public.editions SET tier = upper(r.tier)::public.tier_type, series = r.series, updated_at = now() WHERE id = v_ed;
      c_link := c_link + 1;
    ELSE
      SELECT p.id INTO v_player FROM public.players p
       WHERE p.collection_id = c_ufc AND p.is_active AND lower(p.name) = lower(r.athlete_name)
       ORDER BY p.created_at LIMIT 1;
      IF v_player IS NULL THEN
        v_slug := 'ufc_strike-' || lower(trim(both '-' from regexp_replace(r.athlete_name,'[^A-Za-z0-9]+','-','g')));
        IF EXISTS (SELECT 1 FROM public.players WHERE external_id = v_slug) THEN RAISE EXCEPTION 'player slug % taken', v_slug; END IF;
        INSERT INTO public.players(external_id, collection_id, collection, name, is_active)
        VALUES (v_slug, c_ufc, 'ufc_strike', r.athlete_name, true) RETURNING id INTO v_player;
        INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row) VALUES ('players_m6_created', v_player, jsonb_build_object('name', r.athlete_name));
        c_pl := c_pl + 1;
      END IF;
      SELECT s.id INTO v_set FROM public.sets s WHERE s.collection_id = c_ufc AND upper(s.name) = upper(r.set_name) ORDER BY s.created_at LIMIT 1;
      IF v_set IS NULL THEN
        v_slug := 'ufc_strike-set-' || lower(trim(both '-' from regexp_replace(r.set_name,'[^A-Za-z0-9]+','-','g')));
        IF EXISTS (SELECT 1 FROM public.sets WHERE external_id = v_slug) THEN RAISE EXCEPTION 'set slug % taken', v_slug; END IF;
        INSERT INTO public.sets(external_id, collection_id, name) VALUES (v_slug, c_ufc, r.set_name) RETURNING id INTO v_set;
        INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row) VALUES ('sets_m6_created', v_set, jsonb_build_object('name', r.set_name));
        c_set := c_set + 1;
      END IF;
      INSERT INTO public.editions(external_id, collection_id, collection, player_id, player_name, set_id, set_name,
                                  tier, series, circulation_count, edition_kind, thumbnail_url, video_url, badges, reward_indicators)
      VALUES (r.slug, c_ufc, 'ufc_strike', v_player, (SELECT name FROM public.players WHERE id = v_player), v_set,
              (SELECT name FROM public.sets WHERE id = v_set), upper(r.tier)::public.tier_type, r.series, r.max_ed, 'LE',
              r.preview, r.image, '{}', '{}')
      RETURNING id INTO v_ed;
      INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row) VALUES ('editions_m6_created', v_ed, jsonb_build_object('external_id', r.slug, 'set_id', r.set_id));
      c_ed := c_ed + 1;
    END IF;
    -- the chain map row: insert when missing, else point it at the edition
    INSERT INTO public.ufc_chain_set_editions(set_id, set_name, max_editions, slug, edition_id, edition_external_id)
    VALUES (r.set_id, r.name, r.max_ed, r.slug, v_ed, (SELECT external_id FROM public.editions WHERE id = v_ed))
    ON CONFLICT (set_id) DO UPDATE SET edition_id = EXCLUDED.edition_id, edition_external_id = EXCLUDED.edition_external_id;
  END LOOP;

  -- holdings of any touched edition follow the catalogue
  UPDATE public.wallet_moments_cache w SET tier = e.tier::text, series_number = e.series, player_name = e.player_name, set_name = e.set_name
    FROM public.editions e
   WHERE w.collection_id = c_ufc AND e.collection_id = c_ufc AND w.edition_key = e.external_id
     AND upper(e.external_id) IN (SELECT slug FROM _w)
     AND (w.tier IS DISTINCT FROM e.tier::text OR w.series_number IS DISTINCT FROM e.series::int
          OR w.player_name IS DISTINCT FROM e.player_name OR w.set_name IS DISTINCT FROM e.set_name);

  IF c_ed <> 99 OR c_link <> 1 THEN RAISE EXCEPTION 'created % / linked %, expected 99 / 1', c_ed, c_link; END IF;
  SELECT count(*) INTO n FROM public.ufc_chain_set_editions WHERE set_id IN (SELECT set_id FROM _w) AND edition_id IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION '% target map rows still unlinked', n; END IF;
  RAISE NOTICE 'editions created %, linked %, sets created %, players created %', c_ed, c_link, c_set, c_pl;
END $$;
