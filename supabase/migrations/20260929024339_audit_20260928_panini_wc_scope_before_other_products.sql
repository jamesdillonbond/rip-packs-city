-- audit_20260928_panini_wc_scope_before_other_products
--
-- Panini multi-product, phase 2a (phase 1 = 20260929014444). Every Panini board, the coverage
-- disclosure, the set tracker and the bridge into the shared catalogue read panini_editions as if it
-- were "the WC Prizm catalogue" — true only because 2332 is the only product ever walked. The ingest
-- route's product gate (panini_products.walk_cards) is the one thing keeping it true. This migration
-- makes each WC-only reader say WC explicitly, so switching another product on cannot:
--   · average its cards into WC boards, the nation/player boards or the coverage disclosure,
--   · bridge its editions/FMV into the shared editions / fmv_snapshots / sets / players catalogue
--     (set names like "Base Prizms Silver" recur across products and would MERGE there),
--   · merge its sets into the WC Sets tab (panini_set_progress groups by set_name),
--   · break the squeeze matview refresh (unique key player+set+tier collides across soccer products).
--
-- ZERO BEHAVIOUR CHANGE TODAY, by construction and by measurement: every panini_editions row is
-- packcard-2332_* (5,124 of 5,124, 2026-09-28 ~8 PM PT), so panini_wc_editions = panini_editions
-- row for row. Post-apply: each rewritten view's pg_get_viewdef is md5-equal to the old one with only
-- the table name replaced, every board's row count is unchanged, and the three functions are the
-- verified live bodies (prosrc md5 = the newest defining migration's) with only the table name replaced.
--
-- ⚠ HOW IT WAS APPLIED (2026-09-28 ~7:43 PM PT, version 20260929024339): production received an
-- EQUIVALENT server-side form — a DO block rewriting each object's LIVE definition with the same single
-- replacement — rather than this ~44k-character text re-typed into a tool call. Proven identical after
-- apply: for all 11 views and 3 functions, md5 of the whitespace-normalized live definition equals md5
-- of the same-normalized body in THIS file (views: pg_get_viewdef minus its trailing ';'; functions:
-- prosrc). Row counts before -> after: coverage 62 families / 5,124 editions, nation 62, players 657,
-- deals 271, special serials 12,987, bridge 5,124 editions / 80,137 FMV rows, squeeze 5,124, sets 62 —
-- all unchanged; squeeze sealed exposure $1,143,313 -> $1,143,272 only because the rebuilt matview was
-- recomputed from current FMV (it had been showing its last scheduled refresh). refresh_panini_squeeze()
-- ran clean on the rebuilt matview. Replaying this file yields the same objects.
--
-- Left ALL-PRODUCT on purpose (a collector's NBA cards are theirs too; walk instruments measure the
-- walk): panini_owner_cards, panini_owner_summary, panini_profile_holdings, panini_sales*,
-- panini_recent_sales_fmv, panini_serial_freshness, panini_sale_feed_status, sentinel_panini_health,
-- check_panini_editions_missing_card_stats, panini_fmv_backtest, panini_market_board (reads only
-- bridged editions, so the bridge scope covers it), editions_unified.

-- 1. Product identity on every edition row, derived — never written, so it cannot drift from the id.
alter table public.panini_editions
  add column product_set_id integer generated always as ((substring(external_id from '^packcard-([0-9]+)_'))::integer) stored;
comment on column public.panini_editions.product_set_id is
  'Card product = field 1 of the psku (packcard-<setId>_...). 2332 = 2026 Panini NFT Prizm World Cup Soccer. Registry: panini_products.';

create view public.panini_wc_editions with (security_invoker = on) as
  select * from public.panini_editions where product_set_id = 2332;
revoke all on public.panini_wc_editions from public, anon, authenticated;
grant select on public.panini_wc_editions to service_role;
comment on view public.panini_wc_editions is
  'The 2026 Panini NFT Prizm World Cup Soccer editions (setId 2332). Every WC-only board, the coverage disclosure, the Sets tab and the shared-catalogue bridge read THIS, not panini_editions, so other products can be admitted to panini_editions without leaking into them.';

-- 2. WC boards and coverage read panini_wc_editions. Each body below is the LIVE pg_get_viewdef of
--    2026-09-28 ~8 PM PT with exactly one change: panini_editions -> panini_wc_editions. The post-apply
--    check compares md5(pg_get_viewdef(new)) with md5(regexp_replace(old, '\mpanini_editions\M',
--    'panini_wc_editions', 'g')) captured before this ran, so a transcription slip cannot pass.

create or replace view public.panini_coverage_audit with (security_invoker = on) as
 WITH checklist AS (
         SELECT count(DISTINCT panini_wc_editions.player_name) AS players
           FROM panini_wc_editions
          WHERE ((panini_wc_editions.set_name ~~ 'Base Prizms%'::text) OR (panini_wc_editions.set_name ~~ 'Base Choice%'::text))
        )
 SELECT set_name,
    parallel_family,
    count(*) AS discovered_editions,
    round(avg(mint_cap)) AS avg_mint_cap,
    sum(pulled_count) AS pulled,
    sum(for_sale_count) AS listed_now,
    round(((100.0 * (sum(for_sale_count))::numeric) / (NULLIF(sum(pulled_count), 0))::numeric), 1) AS pct_pulled_listed,
    ( SELECT checklist.players
           FROM checklist) AS base_checklist_players,
        CASE
            WHEN ((set_name ~~ 'Base Prizms%'::text) OR (set_name ~~ 'Base Choice%'::text)) THEN round(((100.0 * (count(*))::numeric) / (NULLIF(( SELECT checklist.players
               FROM checklist), 0))::numeric), 1)
            ELSE NULL::numeric
        END AS pct_of_base_checklist,
        CASE
            WHEN (round(((100.0 * (sum(for_sale_count))::numeric) / (NULLIF(sum(pulled_count), 0))::numeric), 1) >= (90)::numeric) THEN 'listing_gated'::text
            WHEN (round(((100.0 * (sum(for_sale_count))::numeric) / (NULLIF(sum(pulled_count), 0))::numeric), 1) >= (25)::numeric) THEN 'heavily_biased'::text
            WHEN (round(((100.0 * (sum(for_sale_count))::numeric) / (NULLIF(sum(pulled_count), 0))::numeric), 1) >= (10)::numeric) THEN 'partial'::text
            ELSE 'broad'::text
        END AS coverage_flag,
    round((EXTRACT(epoch FROM (now() - max(last_seen_at))) / (3600)::numeric), 1) AS newest_refresh_h,
    round((EXTRACT(epoch FROM (now() - min(last_seen_at))) / (3600)::numeric), 1) AS oldest_refresh_h,
    count(*) FILTER (WHERE (last_seen_at > (now() - '24:00:00'::interval))) AS refreshed_24h,
    count(*) FILTER (WHERE (created_at > (now() - '24:00:00'::interval))) AS first_seen_24h
   FROM panini_wc_editions e
  WHERE (mint_cap IS NOT NULL)
  GROUP BY set_name, parallel_family;

create or replace view public.panini_coverage_summary with (security_invoker = on) as
 WITH per_edition AS (
         SELECT a.set_name,
            a.coverage_flag,
            a.newest_refresh_h,
            a.pct_of_base_checklist,
            generate_series((1)::bigint, a.discovered_editions) AS n
           FROM panini_coverage_audit a
        ), checklist AS (
         SELECT count(DISTINCT panini_wc_editions.player_name) AS players,
            count(DISTINCT panini_wc_editions.player_name) FILTER (WHERE (panini_wc_editions.player_name IN ( SELECT panini_editions_1.player_name
                   FROM panini_wc_editions panini_editions_1
                  GROUP BY panini_editions_1.player_name
                 HAVING (min(panini_editions_1.created_at) > (now() - '24:00:00'::interval))))) AS new_24h
           FROM panini_wc_editions
          WHERE ((panini_wc_editions.set_name ~~ 'Base Prizms%'::text) OR (panini_wc_editions.set_name ~~ 'Base Choice%'::text))
        ), fam AS (
         SELECT max(panini_coverage_audit.pct_of_base_checklist) AS best_pct,
            min(panini_coverage_audit.pct_of_base_checklist) AS worst_pct
           FROM panini_coverage_audit
          WHERE ((panini_coverage_audit.pct_of_base_checklist IS NOT NULL) AND (panini_coverage_audit.discovered_editions >= 30))
        ), age AS (
         SELECT round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY (((EXTRACT(epoch FROM (now() - panini_wc_editions.last_seen_at)) / 3600.0))::double precision)))::numeric, 1) AS p50_h,
            round((percentile_cont((0.9)::double precision) WITHIN GROUP (ORDER BY (((EXTRACT(epoch FROM (now() - panini_wc_editions.last_seen_at)) / 3600.0))::double precision)))::numeric, 1) AS p90_h,
            round(max((EXTRACT(epoch FROM (now() - panini_wc_editions.last_seen_at)) / 3600.0)), 1) AS max_h,
            count(*) FILTER (WHERE (panini_wc_editions.last_seen_at <= (now() - '45 days'::interval))) AS stale_45d,
            round(((100.0 * (count(*) FILTER (WHERE (panini_wc_editions.last_seen_at <= (now() - '45 days'::interval))))::numeric) / (NULLIF(count(*), 0))::numeric), 1) AS pct_stale_45d,
            count(*) FILTER (WHERE (panini_wc_editions.last_seen_at > (now() - '7 days'::interval))) AS walked_7d,
            round(((100.0 * (count(*) FILTER (WHERE (panini_wc_editions.last_seen_at > (now() - '7 days'::interval))))::numeric) / (NULLIF(count(*), 0))::numeric), 1) AS pct_walked_7d
           FROM panini_wc_editions
        )
 SELECT count(*) AS total_editions,
    count(*) FILTER (WHERE (coverage_flag = 'broad'::text)) AS trustworthy_editions,
    round(((100.0 * (count(*) FILTER (WHERE (coverage_flag = 'broad'::text)))::numeric) / (NULLIF(count(*), 0))::numeric), 1) AS pct_trustworthy,
    count(*) FILTER (WHERE (coverage_flag = 'listing_gated'::text)) AS listing_gated_editions,
    count(DISTINCT set_name) FILTER (WHERE (coverage_flag = 'listing_gated'::text)) AS listing_gated_families,
    count(DISTINCT set_name) AS families,
    max(newest_refresh_h) AS oldest_family_refresh_h,
    min(newest_refresh_h) AS newest_family_refresh_h,
    ( SELECT fam.best_pct
           FROM fam) AS best_family_checklist_pct,
    ( SELECT fam.worst_pct
           FROM fam) AS worst_family_checklist_pct,
    ( SELECT checklist.players
           FROM checklist) AS checklist_players_seen,
    ( SELECT checklist.new_24h
           FROM checklist) AS checklist_players_new_24h,
    ( SELECT age.p50_h
           FROM age) AS edition_age_p50_h,
    ( SELECT age.p90_h
           FROM age) AS edition_age_p90_h,
    ( SELECT age.max_h
           FROM age) AS edition_age_max_h,
    ( SELECT age.stale_45d
           FROM age) AS editions_stale_45d,
    ( SELECT age.pct_stale_45d
           FROM age) AS pct_editions_stale_45d,
    ( SELECT age.walked_7d
           FROM age) AS editions_walked_7d,
    ( SELECT age.pct_walked_7d
           FROM age) AS pct_editions_walked_7d
   FROM per_edition c;

create or replace view public.panini_nation_board with (security_invoker = on) as
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
            ( SELECT fs.fmv_usd
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

create or replace view public.panini_player_board with (security_invoker = on) as
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
     LEFT JOIN LATERAL ( SELECT fs.fmv_usd
           FROM panini_fmv_snapshots fs
          WHERE (fs.edition_id = e.id)
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON (true))
  WHERE (e.player_name IS NOT NULL)
  GROUP BY e.player_name;

create or replace view public.panini_deal_board with (security_invoker = on) as
 SELECT s.sku,
    s.edition_external_id,
    e.player_name,
    e.set_name AS parallel,
    e.tier,
    s.serial_number,
    s.mint_cap,
    s.price_usd AS ask_usd,
    s.best_offer_usd,
    s.last_sale_usd,
    f.fmv_usd AS edition_fmv_usd,
    round((f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one))) AS fmv_usd,
    round((((1)::numeric - (s.price_usd / (f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)))) * (100)::numeric)) AS discount_pct,
    round(((f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)) - s.price_usd)) AS est_profit_usd,
        CASE
            WHEN s.is_number_one THEN 'number 1'::text
            WHEN s.is_perfect_mint THEN 'perfect mint'::text
            WHEN s.is_jersey_mint THEN 'jersey mint'::text
            ELSE NULL::text
        END AS special_flag,
    s.owner,
    s.captured_at AS ask_confirmed_at,
    r.med AS recent_sales_median_usd,
    COALESCE(r.n, 0) AS recent_sales_n,
        CASE
            WHEN (r.med IS NOT NULL) THEN 'fmv_and_recent_sales'::text
            ELSE 'fmv_only_no_recent_sales'::text
        END AS deal_basis
   FROM (((panini_card_serials s
     JOIN panini_wc_editions e ON ((e.external_id = s.edition_external_id)))
     JOIN LATERAL ( SELECT fs.fmv_usd,
            fs.confidence
           FROM panini_fmv_snapshots fs
          WHERE (fs.edition_id = e.id)
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON (true))
     LEFT JOIN LATERAL ( SELECT (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((z.p)::double precision)))::numeric AS med,
            (count(*))::integer AS n
           FROM ( SELECT cs.last_sale_usd AS p
                   FROM panini_card_serials cs
                  WHERE ((cs.edition_external_id = e.external_id) AND (cs.last_sale_usd > (0)::numeric) AND (cs.last_sale_at > (now() - '30 days'::interval)) AND (NOT COALESCE(cs.is_special, false)))
                  ORDER BY cs.last_sale_at DESC
                 LIMIT 3) z
         HAVING (count(*) > 0)) r ON (true))
  WHERE (s.is_listed AND (s.price_usd > (0)::numeric) AND (f.fmv_usd >= (25)::numeric) AND (f.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence])) AND (s.price_usd < ((f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)) * 0.85)) AND (s.captured_at > (now() - '7 days'::interval)) AND ((r.med IS NULL) OR (s.price_usd < ((r.med * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)) * 0.85))));

create or replace view public.panini_bridge_candidate_editions with (security_invoker = true) as
 SELECT (external_id)::character varying AS external_id,
    'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid AS collection_id,
    'panini_blockchain'::text AS collection,
    player_name,
    set_name,
    tier,
    mint_cap AS circulation_count,
    thumbnail_url,
    video_url,
    first_minted_at,
    NULL::uuid AS set_id,
    NULL::uuid AS player_id,
    NULL::text AS team_name,
    last_seen_at AS source_last_seen_at,
    (last_seen_at <= (now() - '45 days'::interval)) AS source_is_stale_45d
   FROM panini_wc_editions pe;

-- 3. Two boards read serials FIRST, so the product scope goes on the serial / snapshot key itself.
--    special_serials: LEFT JOIN keeps a WC serial whose edition row is missing (behaviour kept); the
--    prefix predicate is what excludes other products. bridge_candidate_fmv: same, on edition_id.
create or replace view public.panini_special_serials_board with (security_invoker = on) as
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
     LEFT JOIN LATERAL ( SELECT fs.fmv_usd
           FROM panini_fmv_snapshots fs
          WHERE (fs.edition_id = e.id)
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON (true))
  WHERE (s.is_special AND (s.edition_external_id ~~ 'packcard-2332\_%'::text));

create or replace view public.panini_bridge_candidate_fmv with (security_invoker = true) as
 SELECT edition_id AS source_edition_id,
    'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid AS collection_id,
    'panini_blockchain'::text AS collection,
    fmv_usd,
    confidence,
    algo_version,
    computed_at
   FROM panini_fmv_snapshots pf
  WHERE (edition_id ~~ 'packcard-2332\_%'::text);

-- 4. The squeeze materialized view. A matview cannot be CREATE OR REPLACEd, so it and its two
--    dependent views are dropped and rebuilt verbatim (mv body: one table name changed; board and
--    totals: unchanged), with the unique index REFRESH ... CONCURRENTLY needs, the comments and the
--    grants (postgres + service_role only, as before). ⚠ The scope is not cosmetic here: the unique
--    key is (player_name, set_name, tier), which another SOCCER product sharing WC players and set
--    names would collide on — the refresh itself would start failing.
drop view public.panini_squeeze_totals;
drop view public.panini_squeeze_board;
drop materialized view public.mv_panini_squeeze;

create materialized view public.mv_panini_squeeze as
 WITH serial_agg AS (
         SELECT cs.edition_external_id,
            COALESCE(bool_or((cs.nft_type ~~ '%rookie card%'::text)), false) AS is_rookie,
            COALESCE(bool_or((cs.nft_type ~~ '%debut card%'::text)), false) AS is_debut,
            count(*) FILTER (WHERE (cs.last_sale_usd IS NOT NULL)) AS serials_with_recorded_price
           FROM panini_card_serials cs
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
            WHEN (COALESCE(e.mint_cap, 0) > 0) THEN round((((e.pulled_count)::numeric / (e.mint_cap)::numeric) * (100)::numeric), 1)
            ELSE NULL::numeric
        END AS rip_pct,
    e.is_fotl_exclusive,
    COALESCE(sa.is_rookie, false) AS is_rookie,
    COALESCE(sa.is_debut, false) AS is_debut,
    f.fmv_usd,
    round(((e.still_in_packs)::numeric * f.fmv_usd)) AS sealed_fmv_exposure_usd,
    f.confidence AS fmv_confidence,
    e.serial_low_ask_usd,
    e.thumbnail_url,
    COALESCE(sa.serials_with_recorded_price, (0)::bigint) AS serials_with_recorded_price,
    ca.coverage_flag
   FROM (((panini_wc_editions e
     LEFT JOIN serial_agg sa ON ((sa.edition_external_id = e.external_id)))
     LEFT JOIN LATERAL ( SELECT s.fmv_usd,
            s.confidence
           FROM panini_fmv_snapshots s
          WHERE (s.edition_id = e.id)
          ORDER BY s.computed_at DESC
         LIMIT 1) f ON (true))
     LEFT JOIN panini_coverage_audit ca ON (((ca.set_name = e.set_name) AND (NOT (ca.parallel_family IS DISTINCT FROM e.parallel_family)))))
  WHERE (e.mint_cap IS NOT NULL);
create unique index mv_panini_squeeze_key on public.mv_panini_squeeze using btree (player_name, set_name, tier);
revoke all on public.mv_panini_squeeze from public, anon, authenticated;
grant all on public.mv_panini_squeeze to service_role;

create view public.panini_squeeze_board with (security_invoker = on) as
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
   FROM mv_panini_squeeze m;
revoke all on public.panini_squeeze_board from public, anon, authenticated;
grant all on public.panini_squeeze_board to service_role;
comment on view public.panini_squeeze_board is
  'Panini WC Prizm squeeze board. serials_with_recorded_price counts serial-level PRICE COVERAGE (serials carrying last_sale_usd), NOT market activity -- it is unrelated to fmv_confidence, which derives from the upstream marketplace txn count. Renamed from real_sales 2026-07-28.';

create view public.panini_squeeze_totals with (security_invoker = true) as
 SELECT count(*) AS editions,
    round(COALESCE(sum(sealed_fmv_exposure_usd), (0)::numeric)) AS sealed_fmv_exposure_usd,
    count(*) FILTER (WHERE (mint_cap <= 25)) AS chases_lte_25,
    COALESCE(sum(still_in_packs), (0)::bigint) AS sealed_copies,
    count(*) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))) AS editions_hc,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))), (0)::numeric)) AS sealed_fmv_exposure_usd_hc,
    COALESCE(sum(still_in_packs) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))), (0)::bigint) AS sealed_copies_hc,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (coverage_flag = ANY (ARRAY['heavily_biased'::text, 'listing_gated'::text]))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd), (0)::numeric)), 1) AS pct_sealed_usd_from_biased_sets,
    count(*) FILTER (WHERE (fmv_confidence = 'ASK_ONLY'::fmv_confidence)) AS editions_ask_only,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (fmv_confidence = 'ASK_ONLY'::fmv_confidence)), (0)::numeric)) AS sealed_fmv_exposure_usd_ask_only,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (fmv_confidence = 'ASK_ONLY'::fmv_confidence)), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd), (0)::numeric)), 1) AS pct_sealed_usd_from_asks_only,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (fmv_confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence]))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd), (0)::numeric)), 1) AS pct_sealed_usd_sale_backed,
    count(*) FILTER (WHERE ((coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AND (fmv_confidence = 'ASK_ONLY'::fmv_confidence))) AS editions_hc_ask_only,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE ((coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AND (fmv_confidence = 'ASK_ONLY'::fmv_confidence))), (0)::numeric)) AS sealed_fmv_exposure_usd_hc_ask_only,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE ((coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AND (fmv_confidence = 'ASK_ONLY'::fmv_confidence))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))), (0)::numeric)), 1) AS pct_sealed_usd_from_asks_only_hc,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE ((coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AND (fmv_confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence])))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))), (0)::numeric)), 1) AS pct_sealed_usd_sale_backed_hc,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (fmv_confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence]))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd), (0)::numeric)), 1) AS pct_sealed_usd_recent_sale_backed,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE ((coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AND (fmv_confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence])))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))), (0)::numeric)), 1) AS pct_sealed_usd_recent_sale_backed_hc
   FROM panini_squeeze_board
  WHERE (fmv_usd IS NOT NULL);
revoke all on public.panini_squeeze_totals from public, anon, authenticated;
grant all on public.panini_squeeze_totals to service_role;
comment on view public.panini_squeeze_totals is
  'Squeeze headline totals + composition. 2026-09-24 (FMV engine panini-1.1.0): confidence now means RECENT evidence — HIGH/MEDIUM = priced from sales in the last 30 days, LOW = lifetime average of older sales, ASK_ONLY = floor ask x 0.50. pct_sealed_usd_sale_backed(_hc) therefore now counts HIGH+MEDIUM+LOW ("a real sale stands behind it", which is what the page says), and the new pct_sealed_usd_recent_sale_backed(_hc) counts HIGH+MEDIUM. Left at HIGH+MEDIUM, the published sale-backed share would have dropped 69.6% -> 16.7% with no change in underlying evidence.';

-- 5. Functions: verified live bodies, one table name changed. ACLs are preserved by CREATE OR REPLACE.
-- anon-exec: unchanged (sync_panini_editions_to_shared) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
-- anon-exec: unchanged (sync_panini_bridge) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
-- anon-exec: unchanged (panini_set_progress) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
create or replace function public.sync_panini_editions_to_shared(p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- The exit condition from docs/strategy/panini-go-live-2026-09-19.md §4 step 1, as a number the
  -- function enforces rather than a sentence it quotes. Moving it is a new migration, on purpose.
  MAX_STALE_PCT constant numeric := 1.0;

  v_cid uuid;
  v_slug text;
  v_src int := 0;
  v_set_collisions int := 0;
  v_player_collisions int := 0;
  v_sets_target int := 0;
  v_players_target int := 0;
  v_ed_existing int := 0;
  v_rows_multi int := 0;
  v_rows_entity int := 0;
  v_sets_written int := 0;
  v_players_written int := 0;
  v_ed_written int := 0;
  v_unlinked int := 0;
  v_stale_pct numeric;
  v_stale_n bigint;
  v_cov_total bigint;
  v_stale_blocked boolean;
  v_collision_blocked boolean;
begin
  select id, slug into v_cid, v_slug from collections where slug = 'panini_blockchain';
  if v_cid is null then
    raise exception 'sync_panini_editions_to_shared: collections row slug=panini_blockchain not found';
  end if;

  -- ACCURACY GATE, read FAIL-CLOSED. Three ways this read can fail to mean what it says, and all
  -- three must refuse rather than permit: no row at all, a NULL percentage, or a zero denominator
  -- (a percentage over no editions is not 0% stale, it is no measurement).
  select pct_editions_stale_45d, editions_stale_45d, total_editions
    into v_stale_pct, v_stale_n, v_cov_total
  from panini_coverage_summary;

  if not found or v_stale_pct is null or v_cov_total is null or v_cov_total = 0 then
    raise exception 'sync_panini_editions_to_shared: refusing to proceed -- panini_coverage_summary did not yield a usable staleness reading (pct=%, total=%). A failed read is not permission.',
      v_stale_pct, v_cov_total;
  end if;

  v_stale_blocked := (v_stale_pct > MAX_STALE_PCT);

  select count(*) into v_src from panini_wc_editions;
  select count(*) into v_rows_multi from panini_wc_editions where btrim(player_name) like '%|%';
  select count(*) into v_rows_entity from panini_wc_editions
   where btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%';

  select count(*) into v_set_collisions from (
    select btrim(regexp_replace(lower(btrim(set_name)), '[^a-z0-9]+', '-', 'g'), '-') s
    from panini_wc_editions where nullif(btrim(coalesce(set_name,'')),'') is not null
    group by 1 having count(distinct set_name) > 1
  ) z;

  select count(*) into v_player_collisions from (
    select btrim(regexp_replace(lower(btrim(player_name)), '[^a-z0-9]+', '-', 'g'), '-') s
    from panini_wc_editions
    where nullif(btrim(coalesce(player_name,'')),'') is not null
      and btrim(player_name) not like '%|%'
      and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%')
    group by 1 having count(distinct player_name) > 1
  ) z;

  v_collision_blocked := (v_set_collisions > 0 or v_player_collisions > 0);

  select count(distinct set_name) into v_sets_target from panini_wc_editions
   where nullif(btrim(coalesce(set_name,'')),'') is not null;

  select count(distinct btrim(player_name)) into v_players_target from panini_wc_editions
   where nullif(btrim(coalesce(player_name,'')),'') is not null
     and btrim(player_name) not like '%|%'
     and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%');

  select count(*) into v_ed_existing
  from editions e where e.collection_id = v_cid
    and e.external_id in (select pa.external_id from panini_wc_editions pa);

  if p_dry_run then
    return jsonb_build_object(
      'dry_run', true,
      'collection_id', v_cid,
      'source_panini_editions', v_src,
      'would_upsert_sets', v_sets_target,
      'would_upsert_players', v_players_target,
      'would_insert_editions', v_src - v_ed_existing,
      'would_update_editions', v_ed_existing,
      'rows_dual_player_card', v_rows_multi,
      'rows_entity_card', v_rows_entity,
      'rows_left_without_player_link', v_rows_multi + v_rows_entity,
      'set_slug_collisions', v_set_collisions,
      'player_slug_collisions', v_player_collisions,
      -- The staleness gate REPORTS here and RAISES below. Both halves read the same variables, so
      -- a dry run cannot say "clear" about a live run that would refuse.
      'source_pct_stale_45d', v_stale_pct,
      'source_editions_stale_45d', v_stale_n,
      'max_stale_pct', MAX_STALE_PCT,
      'blocked_by_staleness', v_stale_blocked,
      'blocked_by_collisions', v_collision_blocked,
      'blocked', (v_stale_blocked or v_collision_blocked),
      'note', 'The staleness threshold is enforced, not advisory. It does NOT answer the editorial question: a live run makes a listing-gated index (pct_trustworthy ~35%) a full citizen of the shared catalog, and no threshold here measures that.'
    );
  end if;

  if v_stale_blocked then
    -- No literal percent signs in this string. In a plpgsql `raise`, `%%%` is scanned left to
    -- right as `%%` (literal) + `%` (placeholder), so it renders the sign BEFORE the value.
    raise exception 'sync_panini_editions_to_shared: refusing to write -- stale share is % percent (% of % editions not re-priced in 45+ days), above the ceiling of % percent. Bridging now puts stale prices into every cross-collection rollup, where nothing can tell them from live ones.',
      v_stale_pct, v_stale_n, v_cov_total, MAX_STALE_PCT;
  end if;

  if v_collision_blocked then
    raise exception 'sync_panini_editions_to_shared: refusing to write -- % set and % player slug collisions would merge distinct entities',
      v_set_collisions, v_player_collisions;
  end if;

  with s as (
    select distinct
      'panini-' || btrim(regexp_replace(lower(btrim(set_name)), '[^a-z0-9]+', '-', 'g'), '-') as ext,
      btrim(set_name) as nm
    from panini_wc_editions where nullif(btrim(coalesce(set_name,'')),'') is not null
  )
  insert into sets (external_id, collection_id, name, created_at, updated_at)
  select ext, v_cid, nm, now(), now() from s
  on conflict (external_id) do update set name = excluded.name, updated_at = now();
  get diagnostics v_sets_written = row_count;

  with p as (
    select distinct
      'panini-' || btrim(regexp_replace(lower(btrim(player_name)), '[^a-z0-9]+', '-', 'g'), '-') as ext,
      btrim(player_name) as nm
    from panini_wc_editions
    where nullif(btrim(coalesce(player_name,'')),'') is not null
      and btrim(player_name) not like '%|%'
      and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%')
  )
  insert into players (external_id, collection_id, name, collection, created_at, updated_at)
  select ext, v_cid, nm, v_slug, now(), now() from p
  on conflict (external_id) do update set name = excluded.name, updated_at = now();
  get diagnostics v_players_written = row_count;

  insert into editions (
    external_id, collection_id, name, player_id, set_id, tier, circulation_count,
    thumbnail_url, video_url, first_minted_at, collection, player_name, set_name,
    team_name, created_at, updated_at
  )
  select
    pa.external_id,
    v_cid,
    concat_ws(' - ', nullif(btrim(coalesce(pa.player_name,'')),''), nullif(btrim(coalesce(pa.set_name,'')),'')),
    pl.id,
    st.id,
    pa.tier,
    pa.mint_cap,
    public.panini_asset_url(pa.thumbnail_url),
    public.panini_asset_url(pa.video_url),
    pa.first_minted_at,
    v_slug,
    pa.player_name,
    pa.set_name,
    -- This position USED TO carry the source nation column. A NATION IS NOT A TEAM (go-live doc
    -- gap 3), and that column is not even purely nations: 85 distinct values including host cities
    -- ("Dallas", "Vancouver", "San Francisco Bay Area"), "FIFA", and doubled dual-card values
    -- ("Brazil | Brazil"). team_name feeds /[collection]/team/[slug], /my-teams and the team OG
    -- card. (Deliberately not spelling the old expression here: the post-apply assertion greps the
    -- installed body for it, and pg_get_functiondef includes comments.)
    null::text,
    now(),
    now()
  from panini_wc_editions pa
  left join players pl
    on btrim(pa.player_name) not like '%|%'
   and not (btrim(pa.set_name) ilike 'Team Badges%' or btrim(pa.set_name) ilike 'World Cup Posters%')
   and pl.external_id = 'panini-' || btrim(regexp_replace(lower(btrim(pa.player_name)), '[^a-z0-9]+', '-', 'g'), '-')
  left join sets st
    on st.external_id = 'panini-' || btrim(regexp_replace(lower(btrim(pa.set_name)), '[^a-z0-9]+', '-', 'g'), '-')
  on conflict (external_id, collection_id) do update set
    name              = excluded.name,
    player_id         = coalesce(excluded.player_id, editions.player_id),
    set_id            = coalesce(excluded.set_id, editions.set_id),
    tier              = excluded.tier,
    circulation_count = excluded.circulation_count,
    thumbnail_url     = coalesce(excluded.thumbnail_url, editions.thumbnail_url),
    video_url         = coalesce(excluded.video_url, editions.video_url),
    player_name       = excluded.player_name,
    set_name          = excluded.set_name,
    -- excluded.team_name is now always NULL, so this never erases a value a later, deliberate
    -- team mapping puts there.
    team_name         = coalesce(excluded.team_name, editions.team_name),
    updated_at        = now();
  get diagnostics v_ed_written = row_count;

  select count(*) into v_unlinked
  from editions e where e.collection_id = v_cid and e.player_id is null;

  return jsonb_build_object(
    'dry_run', false,
    'collection_id', v_cid,
    'sets_upserted', v_sets_written,
    'players_upserted', v_players_written,
    'editions_upserted', v_ed_written,
    'editions_without_player_link', v_unlinked,
    'expected_without_player_link', v_rows_multi + v_rows_entity,
    'source_pct_stale_45d_at_write', v_stale_pct
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.sync_panini_bridge(p_lookback interval DEFAULT interval '6 hours')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  -- Same ceiling as sync_panini_editions_to_shared (go-live doc §4 step 1). Moving it is a new
  -- migration, on purpose.
  MAX_STALE_PCT constant numeric := 1.0;
  c_coll     constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_started  timestamptz := clock_timestamp();
  v_since    timestamptz;
  v_stale    numeric;
  v_total    bigint;
  v_drift    integer := 0;
  v_catalog  jsonb := NULL;
  v_snaps    integer := 0;
  v_efc      integer := 0;
  v_ok       boolean := true;
  v_err      text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('sync_panini_bridge')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  v_since := CASE WHEN p_lookback IS NULL THEN '-infinity'::timestamptz ELSE now() - p_lookback END;

  BEGIN
    -- ACCURACY GATE, fail-closed: no row, a NULL percentage or a zero denominator all refuse.
    SELECT pct_editions_stale_45d, total_editions INTO v_stale, v_total FROM public.panini_coverage_summary;
    IF NOT FOUND OR v_stale IS NULL OR v_total IS NULL OR v_total = 0 THEN
      RAISE EXCEPTION 'panini coverage reading unusable (pct=%, total=%) -- a failed read is not permission', v_stale, v_total;
    END IF;
    IF v_stale > MAX_STALE_PCT THEN
      RAISE EXCEPTION 'blocked_by_staleness: % percent of Panini editions not re-priced in 45+ days (ceiling % percent)', v_stale, MAX_STALE_PCT;
    END IF;

    -- 1. Catalogue: only when an edition is missing or its bridged fields drifted.
    SELECT count(*)::int INTO v_drift
      FROM public.panini_wc_editions pe
      LEFT JOIN public.editions e ON e.collection_id = c_coll AND e.external_id = pe.external_id
     WHERE e.id IS NULL
        OR (e.tier, e.circulation_count, e.player_name, e.set_name)
           IS DISTINCT FROM (pe.tier, pe.mint_cap, pe.player_name, pe.set_name);
    IF v_drift > 0 THEN
      v_catalog := public.sync_panini_editions_to_shared(false);
    END IF;

    -- 2. Snapshots in the window that are not yet bridged.
    CREATE TEMP TABLE IF NOT EXISTS _panini_bridge_touched (edition_id uuid PRIMARY KEY) ON COMMIT DROP;
    TRUNCATE _panini_bridge_touched;

    WITH ins AS (
      INSERT INTO public.fmv_snapshots
        (edition_id, collection_id, collection, fmv_usd, confidence, algo_version, computed_at)
      SELECT e.id, c_coll, 'panini_blockchain', ps.fmv_usd, ps.confidence, ps.algo_version, ps.computed_at
        FROM public.panini_fmv_snapshots ps
        JOIN public.panini_wc_editions pe ON pe.id = ps.edition_id
        JOIN public.editions e ON e.collection_id = c_coll AND e.external_id = pe.external_id
       WHERE ps.computed_at > v_since
         AND NOT EXISTS (
               SELECT 1 FROM public.fmv_snapshots f
                WHERE f.collection_id = c_coll
                  AND f.edition_id    = e.id
                  AND f.computed_at   = ps.computed_at
                  AND f.algo_version  = ps.algo_version)
      RETURNING edition_id
    ),
    t AS (
      INSERT INTO _panini_bridge_touched SELECT DISTINCT edition_id FROM ins
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM ins) INTO v_snaps;

    -- 3. edition_fmv_current for every touched edition, from its latest snapshot (post-trigger
    --    values). Never moves a row backwards — same rule as refresh_edition_fmv_current.
    WITH latest AS MATERIALIZED (
      SELECT tt.edition_id, s.fmv_usd, s.floor_price_usd, s.confidence, s.computed_at
        FROM _panini_bridge_touched tt
        CROSS JOIN LATERAL (
          SELECT f.fmv_usd, f.floor_price_usd, f.confidence, f.computed_at
            FROM public.fmv_snapshots f
           WHERE f.edition_id = tt.edition_id
           ORDER BY f.computed_at DESC
           LIMIT 1) s
    ),
    up AS (
      INSERT INTO public.edition_fmv_current AS t
        (edition_id, collection_id, fmv_usd, floor_price_usd, confidence, computed_at, refreshed_at)
      SELECT l.edition_id, c_coll, l.fmv_usd, l.floor_price_usd, l.confidence, l.computed_at, now()
        FROM latest l
      ON CONFLICT (edition_id) DO UPDATE SET
        collection_id = EXCLUDED.collection_id, fmv_usd = EXCLUDED.fmv_usd,
        floor_price_usd = EXCLUDED.floor_price_usd, confidence = EXCLUDED.confidence,
        computed_at = EXCLUDED.computed_at, refreshed_at = EXCLUDED.refreshed_at
      WHERE EXCLUDED.computed_at >= t.computed_at
      RETURNING 1
    )
    SELECT count(*)::int INTO v_efc FROM up;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- The block rolls back as a whole: nothing is known to be written.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
    v_catalog := NULL; v_snaps := NULL; v_efc := NULL;
  END;

  PERFORM public.log_pipeline_run('panini-bridge-sync', v_started, NULL, v_snaps, NULL, v_ok, v_err,
                                  'panini_blockchain', NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'via', 'pg_cron',
                                                     'lookback', COALESCE(p_lookback::text, 'full'),
                                                     'pct_stale_45d', v_stale,
                                                     'catalog_drift', v_drift,
                                                     'catalog', v_catalog,
                                                     'snapshots_written', v_snaps,
                                                     'efc_written', v_efc));
  RETURN jsonb_build_object('ok', v_ok, 'error', v_err, 'pct_stale_45d', v_stale, 'catalog_drift', v_drift,
                            'catalog', v_catalog, 'snapshots_written', v_snaps, 'efc_written', v_efc);
END
$function$;

CREATE OR REPLACE FUNCTION public.panini_set_progress(p_username text DEFAULT NULL::text)
RETURNS TABLE(set_name text, editions_seen integer, players_seen integer, min_mint_cap integer, max_mint_cap integer, still_in_packs bigint, owned integer, missing integer, missing_asked integer, missing_unasked integer, cost_usd numeric, max_missing_ask_usd numeric, owner_last_seen_at timestamp with time zone)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH asks AS (
    SELECT s.edition_external_id, min(s.price_usd) AS low_ask
    FROM panini_card_serials s
    WHERE s.is_listed AND s.price_usd > 0 AND s.captured_at > now() - interval '7 days'
    GROUP BY s.edition_external_id
  ), mine AS (
    SELECT s.edition_external_id, max(s.captured_at) AS seen_at
    FROM panini_card_serials s
    WHERE p_username IS NOT NULL AND s.owner <> '' AND lower(s.owner) = lower(p_username)
      AND s.serial_state IS DISTINCT FROM 'BURNT'
    GROUP BY s.edition_external_id
  )
  SELECT
    e.set_name,
    count(*)::integer,
    count(DISTINCT e.player_name)::integer,
    min(e.mint_cap)::integer,
    max(e.mint_cap)::integer,
    sum(e.still_in_packs)::bigint,
    count(m.edition_external_id)::integer,
    count(*) FILTER (WHERE m.edition_external_id IS NULL)::integer,
    count(a.low_ask) FILTER (WHERE m.edition_external_id IS NULL)::integer,
    count(*) FILTER (WHERE m.edition_external_id IS NULL AND a.low_ask IS NULL)::integer,
    round(sum(a.low_ask) FILTER (WHERE m.edition_external_id IS NULL), 2),
    max(a.low_ask) FILTER (WHERE m.edition_external_id IS NULL),
    max(m.seen_at)
  FROM panini_wc_editions e
  LEFT JOIN asks a ON a.edition_external_id = e.external_id
  LEFT JOIN mine m ON m.edition_external_id = e.external_id
  WHERE e.set_name IS NOT NULL
  GROUP BY e.set_name
  ORDER BY count(*) DESC, e.set_name;
$$;
