-- audit_20261029_first_mint_trophies_name_the_parallel — 2026-10-29 ~10:45 AM PT (Claude Code cloud).
--
-- /insights/first-mint listed Top Shot parallels with only their set name: "Peyton Watson · Base
-- Set" appeared twice on Aug 20 ($30 and $81.11, 94x and 198x). These are two editions:
-- 218:8350, a standard print, and 90:4049::4, the Rippled parallel, whose #1 tops the board.
-- 254 of the 519 Top Shot trophies are parallels, and none was named.
--
-- WHAT CHANGES. Both board views append ONE column, subedition_name (the edition's own
-- editions.subedition_name, NULL for a standard print). Existing columns, order and grants are
-- unchanged. security_invoker=on is restated, because CREATE OR REPLACE VIEW would otherwise reset
-- it. editions is publicly readable (policy public_read_editions), so an anon reader still sees
-- every row. All Day carries the column for parity; its 27 trophies have no parallels today.
--
-- REVERT: re-create both views without the last column (DROP VIEW + CREATE, since a column cannot
-- be removed by CREATE OR REPLACE), restating security_invoker=on and the grants listed below.

DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.topshot_first_mint_trophies'::regclass)) <> '452e9b3f2ca7e1ad379eba3a8b9b56fe'
     OR md5(pg_get_viewdef('public.allday_first_mint_trophies'::regclass)) <> 'c6a59845a67ab9eb3ae63f4da2e49414' THEN
    RAISE EXCEPTION 'a first-mint trophies view changed since 2026-10-29; re-read it';
  END IF;
END
$guard$;

CREATE OR REPLACE VIEW public.topshot_first_mint_trophies WITH (security_invoker = on) AS
 SELECT edition_id,
    external_id,
    player_name,
    set_name,
    tier,
    circulation_count,
    mint_one_sold_at,
    mint_one_price_usd,
    avg_other_serial_price_usd,
    other_serial_sample_n,
    multiplier,
    transaction_hash,
    (SELECT e.subedition_name FROM editions e WHERE e.id = m.edition_id) AS subedition_name
   FROM mv_topshot_first_mint_trophies m
  WHERE (EXISTS ( SELECT 1
           FROM collections c
          WHERE c.slug::text = 'nba_top_shot'::text AND c.is_active IS TRUE));

CREATE OR REPLACE VIEW public.allday_first_mint_trophies WITH (security_invoker = on) AS
 SELECT edition_id,
    external_id,
    player_name,
    set_name,
    tier,
    circulation_count,
    mint_one_sold_at,
    mint_one_price_usd,
    avg_other_serial_price_usd,
    other_serial_sample_n,
    multiplier,
    transaction_hash,
    (SELECT e.subedition_name FROM editions e WHERE e.id = m.edition_id) AS subedition_name
   FROM mv_allday_first_mint_trophies m;

-- Post-flight: security_invoker kept on both, and the parallel is named.
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'topshot_first_mint_trophies' AND reloptions @> ARRAY['security_invoker=on'])
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'allday_first_mint_trophies' AND reloptions @> ARRAY['security_invoker=on']) THEN
    RAISE EXCEPTION 'security_invoker lost';
  END IF;
  IF NOT has_table_privilege('anon', 'public.topshot_first_mint_trophies', 'SELECT') THEN
    RAISE EXCEPTION 'anon lost SELECT on topshot_first_mint_trophies';
  END IF;
END
$post$;
