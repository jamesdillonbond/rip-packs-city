-- audit_20261031_squeeze_boards_carry_league — 2026-10-30 ~9:25 PM PT applied (Cowork cloud, autonomous pass).
--
-- Beta feedback 11682 (webz_80, 2026-10-27): "a toggle to switch between NBA and WNBA moments" on
-- /insights/squeeze. The board's view had no league column, so the client could only filter by
-- team or set. This appends `league` to BOTH squeeze sibling views (lib/insights/squeeze-board.ts
-- SQUEEZE_COLS is one select list over both, so a column has to exist on each sibling — the
-- 20261029172523 precedent).
--
-- Top Shot: WNBA when the edition's TEAM is a WNBA franchise label (teams_master.league = 'WNBA'
-- plus the historic / all-star labels Top Shot minted under that teams_master does not carry),
-- OR its SET is WNBA-only (the lib/league.ts WNBA_ONLY_SETS list, mirrored in upsert_wallet_moments).
-- Measured 2026-10-30 ~9:10 PM PT on the ≥ 50 % board: the team rule alone reaches 771 rows, the
-- set rule alone 666 — six MIXED sets (Fresh Gems, Level Up, Road To Royalty, Signature Style,
-- Throne Room, Vintage Vibes) carry 110 WNBA editions the set rule misses, and 5 rows in WNBA sets
-- carry a label (Houston Comets, Sacramento Monarchs, Team Wilson, Team Stewart) no map holds.
-- The OR covers both: 2,311 of 14,506 view rows read WNBA. Everything else is NBA (Team LeBron,
-- Rookie Team and the other all-star / event labels are NBA events).
-- All Day: the constant 'NFL'.
--
-- Guarded by viewdef md5 (read live immediately before this apply), security_invoker=on restated,
-- grants unchanged (CREATE OR REPLACE keeps them). Post-flight asserts +1 column on each.
-- REVERT: DROP + re-CREATE each view without the last column (bodies below minus the league line),
-- restating security_invoker=on, then re-GRANT SELECT ON topshot_squeeze_board TO anon, authenticated.

DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.topshot_squeeze_board'::regclass)) <> '24053f392fabbc52bd1e42acf552cd54'
     OR md5(pg_get_viewdef('public.allday_squeeze_board'::regclass)) <> 'e1fc25ed95c045bcf340b196d9d2b8cc' THEN
    RAISE EXCEPTION 'a squeeze board view changed since 2026-10-30 ~9:10 PM PT; re-read it';
  END IF;
END
$guard$;

CREATE OR REPLACE VIEW public.topshot_squeeze_board WITH (security_invoker = on) AS
 SELECT e.id AS edition_id,
    e.external_id,
    COALESCE(e.player_name, be.player_name) AS player_name,
    COALESCE(e.set_name, be.set_name) AS set_name,
    COALESCE(e.tier::text, replace(be.tier, 'MOMENT_TIER_'::text, ''::text)) AS tier,
    COALESCE(e.circulation_count, be.circulation_count) AS circulation,
    be.locked,
    be.burned,
    round(100.0 * COALESCE(be.locked, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS lock_pct,
    round(100.0 * COALESCE(be.burned, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS burn_pct,
    round(100.0 * (COALESCE(be.locked, 0) + COALESCE(be.burned, 0))::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS squeeze_pct,
    GREATEST(COALESCE(e.circulation_count, be.circulation_count, 0) - COALESCE(be.locked, 0) - COALESCE(be.burned, 0), 0) AS effectively_buyable,
        CASE
            WHEN efc.fmv_usd IS NULL THEN NULL::numeric
            ELSE be.low_ask
        END AS low_ask,
    efc.fmv_usd::numeric(12,4) AS fmv_usd,
    efc.confidence::text AS confidence,
    e.game_date,
    e.thumbnail_url,
    efc.fmv_usd IS NOT NULL AND efc.fmv_usd > 0::numeric AND be.low_ask IS NOT NULL AND be.low_ask > (10::numeric * efc.fmv_usd) AS low_ask_disconnected,
    e.set_id,
    e.team_name,
    tec.top5_share_pct,
        CASE
            WHEN tec.census_complete THEN tec.holders
            ELSE NULL::integer
        END AS holders,
    e.subedition_name,
        CASE
            WHEN e.team_name IN ( SELECT tm.team_name FROM public.teams_master tm WHERE tm.league::text = 'WNBA'
                                  UNION ALL
                                  SELECT v.team_name FROM (VALUES
                                    ('San Antonio Stars'), ('San Antonio Silver Stars'), ('Utah Starzz'),
                                    ('Detroit Shock'), ('Tulsa Shock'), ('Orlando Miracle'),
                                    ('Houston Comets'), ('Sacramento Monarchs'), ('Charlotte Sting'),
                                    ('Cleveland Rockers'), ('Miami Sol'), ('Team Wilson'), ('Team Stewart')
                                  ) v(team_name) )
              OR COALESCE(e.set_name, be.set_name) ~* 'wnba'
              OR COALESCE(e.set_name, be.set_name) IN ('Rise With Us', 'Rise With Us 2023', 'In Her Bag', 'In Their Bag', 'Shining Stars', 'Chasing the Trophy', 'For the Cup')
            THEN 'WNBA'::text
            ELSE 'NBA'::text
        END AS league
   FROM badge_editions be
     JOIN editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
     LEFT JOIN edition_fmv_current efc ON efc.edition_id = e.id
     LEFT JOIN topshot_edition_concentration tec ON tec.edition_external_id = e.external_id::text
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND COALESCE(e.circulation_count, be.circulation_count) IS NOT NULL AND COALESCE(e.circulation_count, be.circulation_count) > 0;

CREATE OR REPLACE VIEW public.allday_squeeze_board WITH (security_invoker = on) AS
 SELECT e.id AS edition_id,
    e.external_id,
    COALESCE(e.player_name, be.player_name) AS player_name,
    COALESCE(e.set_name, be.set_name) AS set_name,
    COALESCE(e.tier::text, replace(be.tier, 'MOMENT_TIER_'::text, ''::text)) AS tier,
    c.circ AS circulation,
    be.locked,
    be.burned,
    round(100.0 * be.locked::numeric / c.circ::numeric, 1) AS lock_pct,
    round(100.0 * be.burned::numeric / c.circ::numeric, 1) AS burn_pct,
    round(100.0 * (be.locked + be.burned)::numeric / c.circ::numeric, 1) AS squeeze_pct,
    GREATEST(c.circ - be.locked - be.burned, 0) AS effectively_buyable,
    fa.floor_ask AS low_ask,
    efc.fmv_usd::numeric(12,4) AS fmv_usd,
    efc.confidence::text AS confidence,
    e.game_date,
    e.thumbnail_url,
    efc.fmv_usd IS NOT NULL AND efc.fmv_usd > 0::numeric AND fa.floor_ask IS NOT NULL AND fa.floor_ask > (10::numeric * efc.fmv_usd) AS low_ask_disconnected,
    e.set_id,
    e.team_name,
    NULL::numeric AS top5_share_pct,
    NULL::integer AS holders,
    e.subedition_name,
    'NFL'::text AS league
   FROM badge_editions be
     JOIN editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
     CROSS JOIN LATERAL ( SELECT COALESCE(e.circulation_count, be.circulation_count) AS circ) c
     LEFT JOIN allday_edition_floor_ask fa ON fa.edition_id = e.id
     LEFT JOIN edition_fmv_current efc ON efc.edition_id = e.id
  WHERE be.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND be.locked IS NOT NULL AND be.burned IS NOT NULL AND c.circ IS NOT NULL AND c.circ > 0;

ALTER VIEW public.topshot_squeeze_board SET (security_invoker = on);
ALTER VIEW public.allday_squeeze_board SET (security_invoker = on);

DO $post$
DECLARE
  n_ts int; n_ad int; so_ts text; so_ad text;
BEGIN
  SELECT count(*) INTO n_ts FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'topshot_squeeze_board';
  SELECT count(*) INTO n_ad FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'allday_squeeze_board';
  IF n_ts <> 24 OR n_ad <> 24 THEN
    RAISE EXCEPTION 'post-flight: expected 24 columns on each squeeze board, got topshot % / allday %', n_ts, n_ad;
  END IF;
  SELECT array_to_string(reloptions, ',') INTO so_ts FROM pg_class WHERE oid = 'public.topshot_squeeze_board'::regclass;
  SELECT array_to_string(reloptions, ',') INTO so_ad FROM pg_class WHERE oid = 'public.allday_squeeze_board'::regclass;
  IF so_ts IS DISTINCT FROM 'security_invoker=on' OR so_ad IS DISTINCT FROM 'security_invoker=on' THEN
    RAISE EXCEPTION 'post-flight: security_invoker lost (% / %)', so_ts, so_ad;
  END IF;
END
$post$;
