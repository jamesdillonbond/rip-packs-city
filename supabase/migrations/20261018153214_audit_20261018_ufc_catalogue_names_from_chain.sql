-- 2026-10-18 8:32 AM PT (Cowork cloud; Trevor "Do it" / "Keep going").
-- UFC catalogue names repaired from the CHAIN, not inferred.
--
-- CAUSE: the 2026-05-10 UFC catalogue ingest split each on-chain set name
-- ("FIGHTER | EVENT | TYPE", or a bare catchphrase for promo moments) on spaces,
-- so (a) hyphen/apostrophe/multi-word surnames leaked a fragment into the set name
-- ("MALLEY UFC 260 KO TKO"), (b) Pride FC moments got the whole string plus the
-- mint size as the fighter ("Anderson Silva Pride Fc 2003 Ko Tko 950"), and
-- (c) catchphrase moments got the phrase as the fighter ("Moicano Wants Money 450").
-- SOURCE OF TRUTH: public.ufc_chain_set_editions (on-chain set names, read 10-04),
-- and for the 10 catchphrase moments the NFT's MetadataViews.Display description
-- read live 2026-10-18 from Flow mainnet, each naming one fighter:
--   CONCEIVE BELIEVE ACHIEVE -> Michael Bisping   | I WILL BE CHAMPION ONE DAY -> Brandon Moreno
--   IM NOT SURPRISED -> Nate Diaz                 | MOICANO WANTS MONEY -> Renato Carneiro (Moicano)
--   MY BALLS WAS HOT -> Derrick Lewis             | P4P. HEADSHOT. DEAD. -> Leon Edwards
--   REMEMBER MY NAME -> Zhang Weili               | SETTLE THE SCORE -> Israel Adesanya
--   SHUT UP! -> Zhang Weili                       | WHO THE F*** IS THAT GUY -> Conor McGregor
-- NOT CHANGED: punctuation-only fighter names ("Benoit Saint Denis"), and the 137
-- editions whose set is the tier word "Contender"/"Fandom" (a catalogue restructure,
-- recorded in docs/strategy/collections/ufc-strike.md).
-- BACKUP: audit_20261018_ufc_names_backup holds every touched editions/sets/players
-- row before the change. REVERT: restore those columns from the backup (one UPDATE per
-- table joined on id); wallet_moments_cache names follow editions on re-run.

CREATE TABLE IF NOT EXISTS public.audit_20261018_ufc_names_backup (
  tbl text NOT NULL, id uuid NOT NULL, row jsonb NOT NULL, taken_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261018_ufc_names_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261018_ufc_names_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  c_ufc constant uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023';
  n int; r record; v_slug text; v_good uuid;
BEGIN
  -- Work set: fight-moment editions with a leaked fragment or a Pride/Noche fighter string.
  CREATE TEMP TABLE _fx ON COMMIT DROP AS
  SELECT e.id, e.external_id, e.player_id, e.set_id, c.set_name AS chain,
         initcap(lower(trim(split_part(c.set_name,'|',1)))) AS want_player,
         upper(regexp_replace(regexp_replace(trim(split_part(c.set_name,'|',2))||' '||trim(split_part(c.set_name,'|',3)),'[^A-Za-z0-9 ]',' ','g'),'\s+',' ','g')) AS want_set,
         e.player_name, e.set_name
    FROM public.editions e JOIN public.ufc_chain_set_editions c ON c.edition_id = e.id
   WHERE e.collection_id = c_ufc AND position('|' in c.set_name) > 0;

  CREATE TEMP TABLE _sets_fix ON COMMIT DROP AS
  SELECT * FROM _fx
   WHERE upper(set_name) <> want_set AND upper(set_name) LIKE '% '||want_set
     AND set_name NOT IN ('Contender','Challenger','Champion','Fandom','Ultimate');
  SELECT count(*) INTO n FROM _sets_fix; IF n <> 19 THEN RAISE EXCEPTION 'expected 19 leaked-fragment sets, got %', n; END IF;

  CREATE TEMP TABLE _players_fix ON COMMIT DROP AS
  SELECT * FROM _fx WHERE player_name ~ ' Pride Fc ' OR player_name = 'Maria Godinez Gonzalez Noche';
  SELECT count(*) INTO n FROM _players_fix; IF n <> 10 THEN RAISE EXCEPTION 'expected 10 garbled fight fighters, got %', n; END IF;

  CREATE TEMP TABLE _phrase(external_id text, player_id uuid) ON COMMIT DROP;
  INSERT INTO _phrase VALUES
    ('CONCEIVE-BELIEVE-ACHIEVE-36190','505229d4-0512-457e-a91d-b493a65e92d4'),
    ('I-WILL-BE-CHAMPION-ONE-DAY-600','ddddb74f-9940-4aee-9057-a76bbecdbe6f'),
    ('IM-NOT-SURPRISED-1000','88a63e2c-8a12-498f-be4b-4397949d4bd0'),
    ('MOICANO-WANTS-MONEY-450','1e767a10-ed00-4c4d-bda2-90db6da7a094'),
    ('MY-BALLS-WAS-HOT-15677','71280171-5283-48c8-96f9-f01968ee85d3'),
    ('P4P-HEADSHOT-DEAD-300','9293f706-555b-4092-aeaa-220144fcdea6'),
    ('REMEMBER-MY-NAME-1231','69ea68c0-7352-4244-91a3-81e3568b06d6'),
    ('SETTLE-THE-SCORE-2342','57fa17a9-5860-4ad8-ad41-8455c8c20fd5'),
    ('SHUT-UP-20830','69ea68c0-7352-4244-91a3-81e3568b06d6'),
    ('WHO-THE-F-IS-THAT-GUY-738','c93d8f9a-aad8-4d4d-ab90-875d9c14535c');

  -- BACKUP (before any write)
  INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
  SELECT 'editions', e.id, to_jsonb(e) FROM public.editions e
   WHERE e.id IN (SELECT id FROM _sets_fix UNION SELECT id FROM _players_fix)
      OR (e.collection_id = c_ufc AND e.external_id IN (SELECT external_id FROM _phrase));
  INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
  SELECT 'sets', s.id, to_jsonb(s) FROM public.sets s
   WHERE s.id IN (SELECT set_id FROM public.editions WHERE id IN (SELECT id FROM public.audit_20261018_ufc_names_backup WHERE tbl='editions'));
  INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
  SELECT 'players', p.id, to_jsonb(p) FROM public.players p
   WHERE p.id IN (SELECT player_id FROM public.editions WHERE id IN (SELECT id FROM public.audit_20261018_ufc_names_backup WHERE tbl='editions'));
  SELECT count(*) INTO n FROM public.audit_20261018_ufc_names_backup WHERE tbl='editions';
  IF n <> 37 THEN RAISE EXCEPTION 'expected 37 edition backups, got %', n; END IF;

  -- (1) leaked-fragment sets: repoint to an existing correct set, else rename the single-edition set row
  FOR r IN SELECT * FROM _sets_fix LOOP
    SELECT s.id INTO v_good FROM public.sets s WHERE s.collection_id = c_ufc AND upper(s.name) = r.want_set AND s.id <> r.set_id LIMIT 1;
    IF v_good IS NOT NULL THEN
      UPDATE public.editions SET set_id = v_good, set_name = r.want_set, updated_at = now() WHERE id = r.id;
    ELSE
      IF (SELECT count(*) FROM public.editions WHERE set_id = r.set_id) <> 1 THEN RAISE EXCEPTION 'set % is shared', r.set_id; END IF;
      v_slug := 'ufc_strike-set-' || lower(trim(both '-' from regexp_replace(r.want_set,'[^A-Za-z0-9]+','-','g')));
      IF EXISTS (SELECT 1 FROM public.sets WHERE external_id = v_slug AND id <> r.set_id) THEN RAISE EXCEPTION 'set slug % taken', v_slug; END IF;
      UPDATE public.sets SET name = r.want_set, external_id = v_slug, updated_at = now() WHERE id = r.set_id;
      UPDATE public.editions SET set_name = r.want_set, updated_at = now() WHERE id = r.id;
    END IF;
  END LOOP;

  -- (2) garbled fight fighters: repoint to an existing active fighter, else rename the single-edition fighter row
  FOR r IN SELECT * FROM _players_fix LOOP
    SELECT p.id INTO v_good FROM public.players p WHERE p.collection_id = c_ufc AND p.is_active AND lower(p.name) = lower(r.want_player) AND p.id <> r.player_id LIMIT 1;
    IF v_good IS NOT NULL THEN
      UPDATE public.editions SET player_id = v_good, player_name = (SELECT name FROM public.players WHERE id = v_good), updated_at = now() WHERE id = r.id;
      UPDATE public.players SET is_active = false, updated_at = now() WHERE id = r.player_id;
    ELSE
      IF (SELECT count(*) FROM public.editions WHERE player_id = r.player_id) <> 1 THEN RAISE EXCEPTION 'player % is shared', r.player_id; END IF;
      v_slug := 'ufc_strike-' || lower(trim(both '-' from regexp_replace(r.want_player,'[^A-Za-z0-9]+','-','g')));
      IF EXISTS (SELECT 1 FROM public.players WHERE external_id = v_slug AND id <> r.player_id) THEN RAISE EXCEPTION 'player slug % taken', v_slug; END IF;
      UPDATE public.players SET name = r.want_player, external_id = v_slug, updated_at = now() WHERE id = r.player_id;
      UPDATE public.editions SET player_name = r.want_player, updated_at = now() WHERE id = r.id;
    END IF;
  END LOOP;

  -- (3) catchphrase moments: the real fighter; garbled single-edition sets take the chain name
  FOR r IN SELECT e.id, e.player_id AS old_player, e.set_id, ph.player_id AS new_player, c.set_name AS chain
             FROM public.editions e JOIN _phrase ph ON ph.external_id = e.external_id
             JOIN public.ufc_chain_set_editions c ON c.edition_id = e.id
            WHERE e.collection_id = c_ufc LOOP
    IF NOT EXISTS (SELECT 1 FROM public.players WHERE id = r.new_player AND is_active) THEN RAISE EXCEPTION 'fighter % missing', r.new_player; END IF;
    UPDATE public.editions SET player_id = r.new_player, player_name = (SELECT name FROM public.players WHERE id = r.new_player), updated_at = now() WHERE id = r.id;
    IF (SELECT count(*) FROM public.editions WHERE player_id = r.old_player) = 0 THEN
      UPDATE public.players SET is_active = false, updated_at = now() WHERE id = r.old_player;
    END IF;
    -- rename only a set whose LETTERS differ from the chain phrase (a fragment like "SURPRISED"),
    -- never one already right up to punctuation, and never a tier-word set.
    IF (SELECT name FROM public.sets WHERE id = r.set_id) NOT IN ('Contender','Challenger','Champion','Fandom','Ultimate')
       AND (SELECT upper(regexp_replace(name,'[^A-Za-z0-9]','','g')) FROM public.sets WHERE id = r.set_id)
           <> upper(regexp_replace(r.chain,'[^A-Za-z0-9]','','g')) THEN
      IF (SELECT count(*) FROM public.editions WHERE set_id = r.set_id) <> 1 THEN RAISE EXCEPTION 'phrase set % shared', r.set_id; END IF;
      v_slug := 'ufc_strike-set-' || lower(trim(both '-' from regexp_replace(r.chain,'[^A-Za-z0-9]+','-','g')));
      IF EXISTS (SELECT 1 FROM public.sets WHERE external_id = v_slug AND id <> r.set_id) THEN RAISE EXCEPTION 'phrase slug % taken', v_slug; END IF;
      UPDATE public.sets SET name = r.chain, external_id = v_slug, updated_at = now() WHERE id = r.set_id;
      UPDATE public.editions SET set_name = r.chain, updated_at = now() WHERE id = r.id;
    END IF;
  END LOOP;

  -- (4) holdings follow the catalogue
  UPDATE public.wallet_moments_cache w
     SET player_name = e.player_name, set_name = e.set_name
    FROM public.editions e
   WHERE w.collection_id = c_ufc AND e.collection_id = c_ufc AND w.edition_key = e.external_id
     AND e.id IN (SELECT id FROM public.audit_20261018_ufc_names_backup WHERE tbl = 'editions')
     AND (w.player_name IS DISTINCT FROM e.player_name OR w.set_name IS DISTINCT FROM e.set_name);

  -- POST-CONDITIONS
  IF EXISTS (SELECT 1 FROM public.editions WHERE collection_id = c_ufc AND (player_name ~ ' Pride Fc ' OR player_name ~ '\s\d+$')) THEN
    RAISE EXCEPTION 'a garbled fighter name survived';
  END IF;
END $$;
