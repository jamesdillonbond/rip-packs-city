-- audit_20261122_panini_value_boards_read_ask_capped_fmv
--
-- anon-exec: revoked (panini_fmv_capped_at_live_ask) — new fn; REVOKE FROM PUBLIC, anon, authenticated below; postgres + service_role only.
--
-- 2026-11-22 (Claude Code cloud; Trevor: "Do what you think is best, and research the answers yourself" — Panini pack-EV
-- strategy P2.9 / finding C8, "cap edition FMV at the live ask everywhere?").
--
-- WHAT WAS ALREADY TRUE. C8 was written from a stale reading. Since 2026-11-12 (20261112183500) every Panini LOW / MEDIUM /
-- HIGH / STALE FMV that reaches the CROSS-COLLECTION table fmv_snapshots is capped at the edition's lowest live ask
-- (listed serials re-read in 7 days) by fmv_snapshots_cap_panini_low_to_live_ask(); that table feeds edition pages,
-- wallets and portfolio. Its shadow read: on the sales the cap changes, within +-25 % of the next sale 11.8 -> 30.3,
-- ratio 2.17 -> 1.40, no tier loses. The pack-EV models cap at the ask too (20261122154549).
--
-- WHAT WAS NOT. Four boards read panini_fmv_snapshots (Panini's own table, UNcapped) and publish it as a VALUE:
--   mv_panini_squeeze (+ panini_squeeze_board)  /insights/panini-squeeze: fmv_usd, sealed_fmv_exposure_usd
--   panini_player_board                          top / catalogue / sealed FMV per player
--   panini_nation_board                          sealed FMV exposure per nation
--   panini_special_serials_board                 a #1 / jersey / perfect-mint serial = edition FMV x premium
-- So one World Cup edition could show two numbers. Measured 11-22 over the 5,285 priced WC editions: 483 (9.1 %) sit
-- above a fresh live ask, median 1.64x; sealed exposure overstated 6.9 % ($680,525 vs $633,380).
--
-- DECISION (P2.9, under Trevor's 11-22 delegation). A VALUE is capped at the live ask everywhere; a DEAL is not.
--   - Value surfaces (the four above) read the same capped number the edition page shows: nobody can be told a card is
--     worth more than it can be bought for right now, and the measured next-sale accuracy says the capped number is right.
--   - panini_deal_board_all is UNCHANGED: a deal IS an ask below FMV, so capping FMV at the ask would delete every deal by
--     construction. It already requires the ask to be < 85 % of the recent-sales median too, when one exists.
-- One rule, one place: panini_fmv_capped_at_live_ask() mirrors the trigger's ask exactly (min price of listed serials
-- captured in the last 7 days), so the boards and fmv_snapshots cannot drift apart.
--
-- HOW (no DROP: same proven path as 20261110210116). The three views are CREATE OR REPLACE with identical columns and
-- WITH (security_invoker = on); their ACLs are preserved. The MV is rebuilt as mv_panini_squeeze_v2 with the same unique
-- key and ACL, panini_squeeze_board is re-pointed, names are swapped, and the old MV stays as
-- mv_panini_squeeze_retired_20261122 (no dependents, no refresher) for a later DROP. refresh_panini_squeeze() resolves the
-- MV by name, so it refreshes the new one unchanged. Premise: every object's viewdef md5 as read 11-22.
--
-- REVERT:
--   re-apply the view bodies from git history (player/nation/special: their pre-11-22 definitions; squeeze:
--   20261110210116) or, for the MV:
--   ALTER MATERIALIZED VIEW public.mv_panini_squeeze RENAME TO mv_panini_squeeze_v2;
--   ALTER INDEX public.mv_panini_squeeze_key RENAME TO mv_panini_squeeze_v2_key;
--   ALTER MATERIALIZED VIEW public.mv_panini_squeeze_retired_20261122 RENAME TO mv_panini_squeeze;
--   ALTER INDEX public.mv_panini_squeeze_retired_20261122_key RENAME TO mv_panini_squeeze_key;
--   CREATE OR REPLACE VIEW public.panini_squeeze_board WITH (security_invoker = on) AS SELECT <same columns> FROM public.mv_panini_squeeze m;

DO $premise$
BEGIN
  IF md5(pg_get_viewdef('public.panini_player_board'::regclass)) <> 'd232fb69d98f6a86bf75d012cf656606'
     OR md5(pg_get_viewdef('public.panini_nation_board'::regclass)) <> 'c9190d24bc75d242073d13c9cab4c8b2'
     OR md5(pg_get_viewdef('public.panini_special_serials_board'::regclass)) <> '5c00d32793c4b59b53b428d035500944'
     OR md5(pg_get_viewdef('public.mv_panini_squeeze'::regclass)) <> '831366c0a6feffd25efaf3f501869e57'
     OR md5(pg_get_viewdef('public.panini_squeeze_board'::regclass)) <> '189d17add348eb2f413821f8b2e1c2f4' THEN
    RAISE EXCEPTION 'premise: a Panini value board changed since 11-22 read; re-read before replacing';
  END IF;
END
$premise$;

create function public.panini_fmv_capped_at_live_ask(p_fmv numeric, p_external_id text)
 returns numeric
 language sql
 stable
 set search_path to 'public', 'pg_temp'
as $function$
  -- The value of a Panini edition: its FMV, capped at the edition's lowest LIVE ask — the same ask
  -- fmv_snapshots_cap_panini_low_to_live_ask() uses (listed serials, price > 0, re-read in 7 days).
  select case when a.ask is not null and a.ask > 0 and p_fmv > a.ask then round(a.ask, 2) else p_fmv end
    from (select min(s.price_usd) as ask
            from panini_card_serials s
           where s.edition_external_id = p_external_id
             and s.is_listed and s.price_usd > 0
             and s.captured_at > now() - interval '7 days') a
$function$;
revoke execute on function public.panini_fmv_capped_at_live_ask(numeric, text) from public, anon, authenticated;
grant execute on function public.panini_fmv_capped_at_live_ask(numeric, text) to postgres, service_role;
comment on function public.panini_fmv_capped_at_live_ask(numeric, text) is
  'Panini edition VALUE = FMV capped at the lowest live ask (listed serials re-read in 7 days) — the rule fmv_snapshots_cap_panini_low_to_live_ask() applies on fmv_snapshots. Read by the Panini value boards (squeeze, player, nation, special serials). NOT for deal boards: a deal is an ask below FMV. 20261122 (P2.9).';

CREATE OR REPLACE VIEW public.panini_player_board WITH (security_invoker = on) AS
 SELECT e.player_name,
    count(*) AS editions,
    count(*) FILTER (WHERE (e.mint_cap <= 25)) AS chases,
    count(*) FILTER (WHERE (EXISTS ( SELECT 1
           FROM panini_card_serials cs
          WHERE ((cs.edition_external_id = e.external_id) AND (cs.nft_type ~~ '%rookie card%'::text))))) AS rookie_editions,
    sum(e.still_in_packs) AS sealed_in_packs,
    max(f.fmv_usd) AS top_fmv_usd,
    round(sum(f.fmv_usd)) AS catalog_fmv_usd,
    round(sum(((e.still_in_packs)::numeric * f.fmv_usd))) AS sealed_fmv_exposure_usd,
    round(avg(
        CASE
            WHEN (COALESCE(e.mint_cap, 0) > 0) THEN (((e.pulled_count)::numeric / (e.mint_cap)::numeric) * (100)::numeric)
            ELSE NULL::numeric
        END), 1) AS avg_rip_pct
   FROM (panini_wc_editions e
     LEFT JOIN LATERAL ( SELECT panini_fmv_capped_at_live_ask(fs.fmv_usd, e.external_id) AS fmv_usd
           FROM panini_fmv_snapshots fs
          WHERE (fs.edition_id = e.id)
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON (true))
  WHERE (e.player_name IS NOT NULL)
  GROUP BY e.player_name;

CREATE OR REPLACE VIEW public.panini_nation_board WITH (security_invoker = on) AS
 WITH counts AS (
         SELECT panini_wc_editions.player_name,
            panini_wc_editions.nation,
            count(*) AS c
           FROM panini_wc_editions
          WHERE ((panini_wc_editions.nation IS NOT NULL) AND (panini_wc_editions.nation <> ''::text))
          GROUP BY panini_wc_editions.player_name, panini_wc_editions.nation
        ), player_nation AS (
         SELECT DISTINCT ON (counts.player_name) counts.player_name,
            counts.nation
           FROM counts
          ORDER BY counts.player_name, counts.c DESC, counts.nation
        ), res AS (
         SELECT e.id,
            e.player_name,
            e.mint_cap,
            COALESCE(e.still_in_packs, 0) AS remain,
            COALESCE(NULLIF(e.nation, ''::text), pn.nation) AS nation,
            ( SELECT panini_fmv_capped_at_live_ask(fs.fmv_usd, e.external_id)
                   FROM panini_fmv_snapshots fs
                  WHERE (fs.edition_id = e.id)
                  ORDER BY fs.computed_at DESC
                 LIMIT 1) AS fmv
           FROM (panini_wc_editions e
             LEFT JOIN player_nation pn ON ((lower(pn.player_name) = lower(e.player_name))))
        )
 SELECT nation,
    count(*) AS editions,
    count(DISTINCT player_name) AS players,
    count(*) FILTER (WHERE (mint_cap <= 25)) AS chases,
    sum(remain) AS sealed_copies,
    round(sum((fmv * (remain)::numeric))) AS sealed_fmv_exposure_usd,
    round(max(fmv)) AS top_fmv_usd,
    (array_agg(player_name ORDER BY fmv DESC NULLS LAST))[1] AS top_player
   FROM res
  WHERE ((nation IS NOT NULL) AND (nation <> ''::text))
  GROUP BY nation
  ORDER BY (round(sum((fmv * (remain)::numeric)))) DESC NULLS LAST;

CREATE OR REPLACE VIEW public.panini_special_serials_board WITH (security_invoker = on) AS
 SELECT s.sku,
    s.edition_external_id,
    s.serial_number,
    s.mint_cap,
    s.is_number_one,
    s.is_jersey_mint,
    s.is_perfect_mint,
        CASE
            WHEN s.is_number_one THEN 'number 1'::text
            WHEN s.is_perfect_mint THEN 'perfect mint'::text
            WHEN s.is_jersey_mint THEN 'jersey mint'::text
            ELSE NULL::text
        END AS headline_flag,
    s.nft_type AS all_flags,
    s.price_usd AS serial_ask_usd,
    s.best_offer_usd,
    s.last_sale_usd,
    s.last_sale_at,
    (COALESCE(s.price_usd, (0)::numeric) > (0)::numeric) AS is_listed,
    s.owner,
    e.player_name,
    e.nation,
    e.set_name AS parallel,
    e.tier,
    f.fmv_usd AS edition_fmv_usd,
    panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one) AS premium_mult,
    round((f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one))) AS serial_fmv_usd,
    s.captured_at AS ask_confirmed_at,
    ((COALESCE(s.price_usd, (0)::numeric) > (0)::numeric) AND (s.captured_at <= (now() - '7 days'::interval))) AS ask_unconfirmed
   FROM ((panini_card_serials s
     LEFT JOIN panini_wc_editions e ON ((e.external_id = s.edition_external_id)))
     LEFT JOIN LATERAL ( SELECT panini_fmv_capped_at_live_ask(fs.fmv_usd, e.external_id) AS fmv_usd
           FROM panini_fmv_snapshots fs
          WHERE (fs.edition_id = e.id)
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON (true))
  WHERE (s.is_special AND (s.edition_external_id ~~ 'packcard-2332\_%'::text));

CREATE MATERIALIZED VIEW public.mv_panini_squeeze_v2 AS
 WITH serial_agg AS (
         SELECT cs.edition_external_id,
            COALESCE(bool_or(cs.nft_type ~~ '%rookie card%'::text), false) AS is_rookie,
            COALESCE(bool_or(cs.nft_type ~~ '%debut card%'::text), false) AS is_debut,
            count(*) FILTER (WHERE cs.last_sale_usd IS NOT NULL) AS serials_with_recorded_price
           FROM panini_card_serials cs
          WHERE cs.edition_external_id IN (SELECT w.external_id FROM panini_wc_editions w WHERE w.mint_cap IS NOT NULL)
          GROUP BY cs.edition_external_id
        )
 SELECT e.id,
    e.external_id,
    e.collection_id,
    e.player_name,
    e.nation,
    e.set_name,
    e.parallel,
    e.parallel_family,
    e.rarity_label,
    e.tier,
    e.mint_cap,
    e.pulled_count,
    e.still_in_packs,
        CASE
            WHEN COALESCE(e.mint_cap, 0) > 0 THEN round(e.pulled_count::numeric / e.mint_cap::numeric * 100::numeric, 1)
            ELSE NULL::numeric
        END AS rip_pct,
    e.is_fotl_exclusive,
    COALESCE(sa.is_rookie, false) AS is_rookie,
    COALESCE(sa.is_debut, false) AS is_debut,
    f.fmv_usd,
    round(e.still_in_packs::numeric * f.fmv_usd) AS sealed_fmv_exposure_usd,
    f.confidence AS fmv_confidence,
    e.serial_low_ask_usd,
    e.thumbnail_url,
    COALESCE(sa.serials_with_recorded_price, 0::bigint) AS serials_with_recorded_price,
    ca.coverage_flag
   FROM panini_wc_editions e
     LEFT JOIN serial_agg sa ON sa.edition_external_id = e.external_id
     LEFT JOIN LATERAL ( SELECT panini_fmv_capped_at_live_ask(s.fmv_usd, e.external_id) AS fmv_usd,
            s.confidence
           FROM panini_fmv_snapshots s
          WHERE s.edition_id = e.id
          ORDER BY s.computed_at DESC
         LIMIT 1) f ON true
     LEFT JOIN panini_coverage_audit ca ON ca.set_name = e.set_name AND NOT ca.parallel_family IS DISTINCT FROM e.parallel_family
  WHERE e.mint_cap IS NOT NULL;

CREATE UNIQUE INDEX mv_panini_squeeze_v2_key ON public.mv_panini_squeeze_v2 USING btree (player_name, set_name, tier);
REVOKE ALL ON public.mv_panini_squeeze_v2 FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mv_panini_squeeze_v2 TO service_role;

-- Same rows and the same column shape as the MV it replaces.
DO $$
DECLARE v_new int; v_old int; v_cols_old text; v_cols_new text;
BEGIN
  SELECT count(*) INTO v_new FROM public.mv_panini_squeeze_v2;
  SELECT count(*) INTO v_old FROM public.panini_wc_editions WHERE mint_cap IS NOT NULL;
  IF v_new <> v_old THEN RAISE EXCEPTION 'mv_panini_squeeze_v2: % rows vs % base editions', v_new, v_old; END IF;
  SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) INTO v_cols_old
    FROM pg_attribute WHERE attrelid = 'public.mv_panini_squeeze'::regclass AND attnum > 0 AND NOT attisdropped;
  SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) INTO v_cols_new
    FROM pg_attribute WHERE attrelid = 'public.mv_panini_squeeze_v2'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols_old IS DISTINCT FROM v_cols_new THEN RAISE EXCEPTION 'column shape differs: % vs %', v_cols_old, v_cols_new; END IF;
END $$;

CREATE OR REPLACE VIEW public.panini_squeeze_board WITH (security_invoker = on) AS
 SELECT id,
    external_id,
    collection_id,
    player_name,
    nation,
    set_name,
    parallel,
    parallel_family,
    rarity_label,
    tier,
    mint_cap,
    pulled_count,
    still_in_packs,
    rip_pct,
    is_fotl_exclusive,
    is_rookie,
    is_debut,
    fmv_usd,
    sealed_fmv_exposure_usd,
    fmv_confidence,
    serial_low_ask_usd,
    thumbnail_url,
    serials_with_recorded_price,
    coverage_flag
   FROM public.mv_panini_squeeze_v2 m;

ALTER MATERIALIZED VIEW public.mv_panini_squeeze RENAME TO mv_panini_squeeze_retired_20261122;
ALTER INDEX public.mv_panini_squeeze_key RENAME TO mv_panini_squeeze_retired_20261122_key;
ALTER MATERIALIZED VIEW public.mv_panini_squeeze_v2 RENAME TO mv_panini_squeeze;
ALTER INDEX public.mv_panini_squeeze_v2_key RENAME TO mv_panini_squeeze_key;
REVOKE ALL ON public.mv_panini_squeeze_retired_20261122 FROM PUBLIC, anon, authenticated;
