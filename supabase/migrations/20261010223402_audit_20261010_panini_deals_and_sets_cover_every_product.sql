-- audit_20261010_panini_deals_and_sets_cover_every_product
--
-- Panini multi-product, phase 3 (phase 2a = 20260929024339, which scoped every WC-only reader to
-- panini_wc_editions BEFORE other products were admitted). Since then 79+ products across Soccer,
-- Basketball, Football, Womens Basketball and Baseball are walked and priced (panini-1.x snapshots
-- per edition), but the Sniper tab and the Sets tab still showed World Cup only — a Football or NBA
-- collector got no deals and no set progress. Trevor, 2026-10-10: "Do it all".
--
-- 1. panini_deal_board_all — the deal board over EVERY catalogued product, carrying product_set_id,
--    product_name (panini_products.name; NULL until the registry names it) and sport
--    (panini_products.last_grid_sport). Same deal rules as the WC board, verbatim (>= 15 % under
--    premium-adjusted FMV, FMV >= $25 at HIGH/MEDIUM/LOW, ask re-read in 7 days, and under the
--    recent-sales median when one exists).
--    ⚠ COST, measured 2026-10-10 PT: the WC body over all products (a per-SERIAL lateral FMV probe,
--    172k loops) = 716k buffers / 5.3 s. The latest FMV is resolved ONCE PER EDITION in a
--    MATERIALIZED CTE instead (24k probes), then hash-joined: 138k buffers / 0.46 s, the SAME 798
--    rows. Read hourly by the panini-boards snapshot.
-- 2. panini_deal_board (WC) becomes exactly panini_deal_board_all filtered to product_set_id = 2332,
--    with its column list unchanged — one body, so the two boards cannot drift apart. The
--    /insights/panini-squeeze Deals tab (the WC squeeze board) keeps reading it.
-- 3. panini_set_progress_all(p_username) — panini_set_progress grouped per (product, set) over every
--    product, with product_set_id / product_name / sport. panini_set_progress (WC) is untouched.
--    Set names ("Base Prizms Silver") recur across products, so the grouping key MUST include the
--    product or sets of different products merge.
--
-- anon-exec: revoked (panini_set_progress_all) — new function; REVOKE FROM PUBLIC, anon, authenticated below, service_role only, as panini_set_progress.
--
-- REVERT:
--   create or replace view public.panini_deal_board with (security_invoker = on) as <the body in
--   20260929024339, section 2>;  drop view public.panini_deal_board_all;
--   drop function public.panini_set_progress_all(text);

create view public.panini_deal_board_all with (security_invoker = on) as
 WITH ef AS MATERIALIZED (
         SELECT e.id,
            e.external_id,
            e.product_set_id,
            e.player_name,
            e.set_name,
            e.tier,
            f.fmv_usd,
            f.confidence
           FROM panini_editions e
             CROSS JOIN LATERAL ( SELECT fs.fmv_usd,
                    fs.confidence
                   FROM panini_fmv_snapshots fs
                  WHERE (fs.edition_id = e.id)
                  ORDER BY fs.computed_at DESC
                 LIMIT 1) f
          WHERE ((f.fmv_usd >= (25)::numeric) AND (f.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence])))
        )
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
    e.fmv_usd AS edition_fmv_usd,
    round((e.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one))) AS fmv_usd,
    round((((1)::numeric - (s.price_usd / (e.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)))) * (100)::numeric)) AS discount_pct,
    round(((e.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)) - s.price_usd)) AS est_profit_usd,
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
        END AS deal_basis,
    e.product_set_id,
    p.name AS product_name,
    p.last_grid_sport AS sport
   FROM (((panini_card_serials s
     JOIN ef e ON ((e.external_id = s.edition_external_id)))
     LEFT JOIN panini_products p ON ((p.set_id = e.product_set_id)))
     LEFT JOIN LATERAL ( SELECT (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((z.p)::double precision)))::numeric AS med,
            (count(*))::integer AS n
           FROM ( SELECT cs.last_sale_usd AS p
                   FROM panini_card_serials cs
                  WHERE ((cs.edition_external_id = e.external_id) AND (cs.last_sale_usd > (0)::numeric) AND (cs.last_sale_at > (now() - '30 days'::interval)) AND (NOT COALESCE(cs.is_special, false)))
                  ORDER BY cs.last_sale_at DESC
                 LIMIT 3) z
         HAVING (count(*) > 0)) r ON (true))
  WHERE (s.is_listed AND (s.price_usd > (0)::numeric) AND (s.price_usd < ((e.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)) * 0.85)) AND (s.captured_at > (now() - '7 days'::interval)) AND ((r.med IS NULL) OR (s.price_usd < ((r.med * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)) * 0.85))));
revoke all on public.panini_deal_board_all from public, anon, authenticated;
grant select on public.panini_deal_board_all to service_role;
comment on view public.panini_deal_board_all is
  'Panini deal board over EVERY catalogued product (the Sniper tab): listed serials >= 15% under premium-adjusted FMV. panini_deal_board is this filtered to WC (2332). Latest FMV resolved once per edition (MATERIALIZED CTE): 138k buffers vs 716k per-serial, 2026-10-10.';

create or replace view public.panini_deal_board with (security_invoker = on) as
 SELECT sku,
    edition_external_id,
    player_name,
    parallel,
    tier,
    serial_number,
    mint_cap,
    ask_usd,
    best_offer_usd,
    last_sale_usd,
    edition_fmv_usd,
    fmv_usd,
    discount_pct,
    est_profit_usd,
    special_flag,
    owner,
    ask_confirmed_at,
    recent_sales_median_usd,
    recent_sales_n,
    deal_basis
   FROM panini_deal_board_all
  WHERE (product_set_id = 2332);
comment on view public.panini_deal_board is
  'WC (2332) deals = panini_deal_board_all filtered to the WC product, columns unchanged (2026-10-10). Read by the /insights/panini-squeeze Deals tab.';

create function public.panini_set_progress_all(p_username text)
returns table(product_set_id integer, product_name text, sport text, set_name text, editions_seen integer, players_seen integer,
  min_mint_cap integer, max_mint_cap integer, still_in_packs bigint, owned integer, missing integer, missing_asked integer,
  missing_unasked integer, cost_usd numeric, max_missing_ask_usd numeric, owner_last_seen_at timestamp with time zone)
language sql stable
set search_path = public
as $function$
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
    e.product_set_id,
    max(p.name),
    max(p.last_grid_sport),
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
  FROM panini_editions e
  LEFT JOIN panini_products p ON p.set_id = e.product_set_id
  LEFT JOIN asks a ON a.edition_external_id = e.external_id
  LEFT JOIN mine m ON m.edition_external_id = e.external_id
  WHERE e.set_name IS NOT NULL AND e.product_set_id IS NOT NULL
  GROUP BY e.product_set_id, e.set_name
  ORDER BY e.product_set_id = 2332 DESC, count(*) DESC, e.product_set_id, e.set_name;
$function$;
revoke all on function public.panini_set_progress_all(text) from public, anon, authenticated;
grant execute on function public.panini_set_progress_all(text) to postgres, service_role;
comment on function public.panini_set_progress_all(text) is
  'Panini Sets tab over every product: panini_set_progress grouped per (product_set_id, set_name) — set names recur across products. Editions SEEN (listing-gated), cost to finish at confirmed 7-day asks. WC first. 2026-10-10.';
