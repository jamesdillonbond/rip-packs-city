-- audit_20261108_panini_entertainment_nomenclature
--
-- 2026-11-08 (Claude Code, Trevor's Windows box; Trevor: "Figure out if there's a better naming
-- nomenclature for Panini entertainment" → "Yes do it all"). Panini's Entertainment filter
-- (enumerated since 11-08 ~9:48 AM PT) served six products no sport serves. Panini reuses its
-- SPORTS fields for them: `team` = the IP / brand / band, `athlete` = the figure on the card —
--   2130 The Rolling Stones / Keith Richards · 850179 Sunnyside Silvershells / Victor Yolkov ·
--   850147 Zombie Mob / Grrregg · 850178 Moonbirds / Lance · 850130 Bad Eggs / Shelby ·
--   987654321 Panini / General Admission (NFT Party tickets).
-- Bridged as they come, the site would say "Player: Keith Richards", "Team: Bad Eggs", and the
-- products bridge would MINT a players row for every character (Grrregg in player search, the
-- hubs and the concierge's resolver). This follows Pinnacle's precedent instead: a character is
-- not a person.
--
-- WHAT.
--   1. panini_products.label_set ('sports' | 'entertainment' | 'music') and .franchise. The
--      effective set is label_set, else 'entertainment' when the product's grid sport is
--      'Entertainment' — so a FUTURE entertainment product is named right without a row edit;
--      'music' is the explicit override (a band member is not a "character").
--   2. The six products: 2130 music / "The Rolling Stones"; the four Bad Egg Co. / Moonbirds
--      lines entertainment / their Panini `team`; 987654321 (event tickets) noted and NEVER
--      admitted.
--   3. Admission (walk_cards) of the five collectible lines — each clears the handoff's 50+
--      listing bar (1,056 / 688 / 188 / 90 / 70 on the 11:04 AM PT run).
--   4. sync_panini_products_bridge, two in-place splices of the LIVE body (as 20261021053313 /
--      20261021065738 did): (a) an entertainment/music product's rows never mint or link a
--      players row — player_ext and alias_player are cleared after the source load, so player_id
--      stays NULL and the figure stays the edition's LABEL (editions.player_name); (b) such an
--      edition's team_name is the product's franchise (it was NULL for every non-WC product),
--      on insert and on update.
--   The site's labels follow the same effective set: lib/entity-labels.ts + lib/panini/label-set.ts.
--
-- anon-exec: unchanged (sync_panini_products_bridge) — CREATE OR REPLACE via an in-place splice of an existing fn, same signature; ACL preserved.
-- REVERT: UPDATE public.panini_products SET walk_cards = false, walk_cards_since = NULL
--           WHERE set_id IN (2130, 850179, 850147, 850178, 850130);
--         the inverse splice (o/n swapped) of the bridge;
--         ALTER TABLE public.panini_products DROP COLUMN label_set, DROP COLUMN franchise;
--         (editions the bridge wrote for those products: DELETE … WHERE collection_id = Panini AND
--          external_id LIKE 'packcard-2130\_%' etc. — they carry no players rows to clean up)

ALTER TABLE public.panini_products
  ADD COLUMN IF NOT EXISTS label_set text CHECK (label_set IN ('sports', 'entertainment', 'music')),
  ADD COLUMN IF NOT EXISTS franchise text;
COMMENT ON COLUMN public.panini_products.label_set IS
  'Naming for the site and the products bridge (2026-11-08): sports (Player/Team) | entertainment (Character/Franchise/Cast, no players rows) | music (Artist/Band/Lineup, no players rows). NULL = entertainment when last_grid_sport = ''Entertainment'', else sports.';
COMMENT ON COLUMN public.panini_products.franchise IS
  'The IP / brand / band an entertainment product belongs to (Panini''s card `team` field). The products bridge writes it to editions.team_name for entertainment/music products.';

UPDATE public.panini_products SET label_set = 'music', franchise = 'The Rolling Stones' WHERE set_id = 2130;
UPDATE public.panini_products SET label_set = 'entertainment', franchise = sample->>'team'
 WHERE set_id IN (850179, 850147, 850178, 850130);
UPDATE public.panini_products
   SET label_set = 'entertainment',
       note = coalesce(note || ' | ', '') || 'Event tickets (NFT Party General Admission), not a collectible line — never admit (2026-11-08).'
 WHERE set_id = 987654321;

UPDATE public.panini_products SET walk_cards = true, walk_cards_since = now()
 WHERE set_id IN (2130, 850179, 850147, 850178, 850130) AND walk_cards IS NOT TRUE;

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.sync_panini_products_bridge(interval)'::regprocedure);
  o1 text := $o$    GET DIAGNOSTICS v_src = ROW_COUNT;
$o$;
  n1 text := $n$    GET DIAGNOSTICS v_src = ROW_COUNT;
    -- 2026-11-08: an ENTERTAINMENT / MUSIC product's figure (a band member, a Bad Egg
    -- character) is not a PERSON — never mint or link a players row; the name stays the
    -- edition's label. Effective set: label_set, else entertainment for the Entertainment grid.
    UPDATE _pp_src s SET player_ext = NULL, alias_player = NULL
      FROM public.panini_products pr
     WHERE pr.set_id = s.product_set_id
       AND coalesce(pr.label_set, CASE WHEN pr.last_grid_sport = 'Entertainment' THEN 'entertainment' END)
           IN ('entertainment', 'music');
$n$;
  o2 text := $o$           NULL::text, now(), now()
      FROM src
$o$;
  n2 text := $n$           (SELECT nullif(btrim(pr2.franchise), '') FROM public.panini_products pr2
             WHERE pr2.set_id = src.product_set_id
               AND coalesce(pr2.label_set, CASE WHEN pr2.last_grid_sport = 'Entertainment' THEN 'entertainment' END)
                   IN ('entertainment', 'music')),
           now(), now()
      FROM src
$n$;
  o3 text := $o$      set_name          = excluded.set_name,
      updated_at        = now();$o$;
  n3 text := $n$      set_name          = excluded.set_name,
      team_name         = coalesce(excluded.team_name, editions.team_name),
      updated_at        = now();$n$;
  v_hits int;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, o1, ''))) / length(o1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'source-load anchor found % times, want 1', v_hits; END IF;
  v_hits := (length(v_def) - length(replace(v_def, o2, ''))) / length(o2);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'team_name insert anchor found % times, want 1', v_hits; END IF;
  v_hits := (length(v_def) - length(replace(v_def, o3, ''))) / length(o3);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'update-set anchor found % times, want 1', v_hits; END IF;
  v_def := replace(replace(replace(v_def, o1, n1), o2, n2), o3, n3);
  EXECUTE v_def;
END
$mig$;
