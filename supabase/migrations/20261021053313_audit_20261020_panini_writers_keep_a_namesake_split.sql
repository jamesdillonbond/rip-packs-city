-- audit_20261020_panini_writers_keep_a_namesake_split
--
-- 2026-10-20 10:33 PM PT (Claude Code cloud; Trevor: "work on roadmap items and known
-- issues"). known-issues #201: Panini merges two Luis Suárez into one player, and a
-- hand split would be undone by a writer.
--
-- WHAT WAS WRONG. Both Panini catalog writers derive editions.player_id from the card's
-- player NAME (slug, or player_name_aliases on the products bridge) and write it with
-- `player_id = coalesce(excluded.player_id, editions.player_id)`. A name is not a person
-- (CLAUDE.md concierge rule 2): when two people share a card name, repointing one's
-- editions to their own players row lasts only until the next write —
--   - sync_panini_editions_to_shared (2026 WC set, product 2332), run by
--     sync_panini_bridge (pg_cron rpc-panini-bridge-sync, :14/:44) whenever any WC
--     edition's bridged fields drift, re-links EVERY WC edition by slug;
--   - sync_panini_products_bridge (pg_cron rpc-panini-products-bridge, :24/:54) counts
--     `e.player_id IS DISTINCT FROM src.player_id` as drift, so it would re-link the
--     repointed editions on its very next tick.
--
-- WHAT CHANGES. Both writers honour a recorded identity: when player_relations records
-- the edition's CURRENT player as a different person from the one the name resolves to
-- (namesake / parent_of either direction, or a name_change row on the current player —
-- public.edition_player_is_other_person, 20261021034822, the same test the readers use),
-- the writer keeps the current link. Everything else is byte-for-byte unchanged:
--   - sync_panini_editions_to_shared: the ON CONFLICT player_id assignment.
--   - sync_panini_products_bridge: the same assignment, and the drift test, so a kept
--     split is not re-offered as drift every tick.
-- An edition with no relation (every edition but a split's) resolves exactly as before:
-- the helper is FALSE when the current player is NULL, equals the resolved one, or no
-- relation names the pair.
--
-- Measured before apply (10:20 PM PT): 29 editions on players row 538b7294 (Uruguay's
-- Luis Suárez), 18 of them the Colombian Luis Javier Suárez's (Granada CF, Marseille,
-- UD Almería, Colombia's 2026 WC #186). The split itself is a data statement:
-- docs/audits/2026-10-20-panini-luis-suarez-namesake-split.sql.
--
-- anon-exec: unchanged (sync_panini_editions_to_shared) — CREATE OR REPLACE of the same signature keeps its ACL.
-- anon-exec: unchanged (sync_panini_products_bridge) — CREATE OR REPLACE of the same signature keeps its ACL.
--
-- REVERT: re-run the splices in reverse (new fragment -> old fragment); the md5 of each
-- pre-change body is pinned below.
DO $mig$
DECLARE
  d text;
  n int;
  c_wc_md5 constant text := '1c2811b594bdec56956620d70a32e307';
  c_pp_md5 constant text := 'b9d0b94585cd9e1bc8d86ae94c67a119';
  w_old constant text := E'\n    player_id         = coalesce(excluded.player_id, editions.player_id),\n';
  w_new constant text := E'\n    player_id         = CASE WHEN public.edition_player_is_other_person(editions.player_id, excluded.player_id)\n                             THEN editions.player_id\n                             ELSE coalesce(excluded.player_id, editions.player_id) END,\n';
  p_old constant text := E'\n      player_id         = coalesce(excluded.player_id, editions.player_id),\n';
  p_new constant text := E'\n      player_id         = CASE WHEN public.edition_player_is_other_person(editions.player_id, excluded.player_id)\n                               THEN editions.player_id\n                               ELSE coalesce(excluded.player_id, editions.player_id) END,\n';
  q_old constant text := E'        OR (src.player_id IS NOT NULL AND e.player_id IS DISTINCT FROM src.player_id)\n';
  q_new constant text := E'        OR (src.player_id IS NOT NULL AND e.player_id IS DISTINCT FROM src.player_id\n            AND NOT public.edition_player_is_other_person(e.player_id, src.player_id))\n';
BEGIN
  -- ── sync_panini_editions_to_shared ──
  SELECT md5(prosrc) INTO d FROM pg_proc WHERE oid = 'public.sync_panini_editions_to_shared(boolean)'::regprocedure;
  IF d <> c_wc_md5 THEN RAISE EXCEPTION 'sync_panini_editions_to_shared body moved (md5 %), re-read before splicing', d; END IF;
  d := pg_get_functiondef('public.sync_panini_editions_to_shared(boolean)'::regprocedure);
  n := (length(d) - length(replace(d, w_old, ''))) / length(w_old);
  IF n <> 1 THEN RAISE EXCEPTION 'wc player_id anchor found % times, want 1', n; END IF;
  d := replace(d, w_old, w_new);
  EXECUTE d;

  -- ── sync_panini_products_bridge ──
  SELECT md5(prosrc) INTO d FROM pg_proc WHERE oid = 'public.sync_panini_products_bridge(interval)'::regprocedure;
  IF d <> c_pp_md5 THEN RAISE EXCEPTION 'sync_panini_products_bridge body moved (md5 %), re-read before splicing', d; END IF;
  d := pg_get_functiondef('public.sync_panini_products_bridge(interval)'::regprocedure);
  n := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
  IF n <> 1 THEN RAISE EXCEPTION 'products player_id anchor found % times, want 1', n; END IF;
  d := replace(d, p_old, p_new);
  n := (length(d) - length(replace(d, q_old, ''))) / length(q_old);
  IF n <> 1 THEN RAISE EXCEPTION 'products drift anchor found % times, want 1', n; END IF;
  d := replace(d, q_old, q_new);
  EXECUTE d;
END
$mig$;
