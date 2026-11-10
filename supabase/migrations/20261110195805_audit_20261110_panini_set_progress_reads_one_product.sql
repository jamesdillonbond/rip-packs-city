-- audit_20261110_panini_set_progress_reads_one_product
--
-- Claude Code cloud, 2026-11-10 ~11:50 AM PT (applied 11:58 AM PT). Inbox 2026-11-10T1910Z (daytime monitor):
-- /api/panini-set-progress missed its 8 s read budget on `panini-set-progress-products`.
--
-- WHY: both reads behind the Panini Sets tab computed EVERY product's set progress, including
-- the market-wide 7-day low ask over all ~296k listed serials (~1.1 s, 64k buffers), then threw
-- most of it away: the picker (`panini_set_progress_products`) never uses an ask, and the sets
-- table filtered `panini_set_progress_all(...)` on product_set_id AFTER the function returned
-- (a SQL function with SET search_path is never inlined, so the filter cannot be pushed down).
--   1. panini_set_progress_products: same output, no ask scan (it only counts sets / editions / owned).
--   2. NEW panini_set_progress_for_product(p_username, p_product_set_id): the _all body scoped to one
--      product, with the low ask read per edition (LATERAL on idx_panini_serials_listed_edition_cover):
--      World Cup (largest, 5,302 editions) 64,104 -> 23,981 buffers.
-- panini_set_progress_all is unchanged (the concierge's set-completion tool reads it across products).
--
-- EQUIVALENCE (measured before applying, pg_temp copies vs live at the same instant):
--   products: 448 rows over usernames {NULL, bossman0, derekman47, gerpgerp12}, EXCEPT both ways = 0
--             (2,080 owned editions in the sample, so the owner arm is exercised).
--   for_product vs _all filtered: 389 rows over products {2332, 1933, 1940} x usernames
--             {NULL, bossman0, derekman47}, EXCEPT both ways = 0 (345 priced, 642 owned).
--   panini_products.set_id is unique (164/164), so joining products after the set-level GROUP BY
--   cannot change a count.
--
-- anon-exec: unchanged (panini_set_progress_products) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false.
-- anon-exec: revoked (panini_set_progress_for_product) — new function; REVOKE FROM PUBLIC, anon, authenticated below, service_role only.
--
-- REVERT:
--   drop function public.panini_set_progress_for_product(text, integer);
--   and re-apply the products body from 20261010223446_audit_20261010_panini_set_progress_products.sql
--   (route: app/api/panini-set-progress/route.ts back to panini_set_progress_all + .eq("product_set_id")).

create or replace function public.panini_set_progress_products(p_username text)
returns table(product_set_id integer, product_name text, sport text, sets integer, editions_seen integer, owned integer,
  owner_last_seen_at timestamp with time zone)
language sql stable
set search_path = public
as $function$
  WITH mine AS (
    SELECT s.edition_external_id, max(s.captured_at) AS seen_at
    FROM panini_card_serials s
    WHERE p_username IS NOT NULL AND s.owner <> '' AND lower(s.owner) = lower(p_username)
      AND s.serial_state IS DISTINCT FROM 'BURNT'
    GROUP BY s.edition_external_id
  ), sets AS (
    SELECT e.product_set_id, e.set_name,
           count(*) AS editions_seen,
           count(m.edition_external_id) AS owned,
           max(m.seen_at) AS seen_at
    FROM panini_editions e
    LEFT JOIN mine m ON m.edition_external_id = e.external_id
    WHERE e.set_name IS NOT NULL AND e.product_set_id IS NOT NULL
    GROUP BY e.product_set_id, e.set_name
  )
  SELECT s.product_set_id,
         max(p.name),
         max(p.last_grid_sport),
         count(*)::integer,
         sum(s.editions_seen)::integer,
         sum(s.owned)::integer,
         max(s.seen_at)
  FROM sets s
  LEFT JOIN panini_products p ON p.set_id = s.product_set_id
  GROUP BY s.product_set_id
  ORDER BY s.product_set_id = 2332 DESC, sum(s.editions_seen) DESC, s.product_set_id;
$function$;

create function public.panini_set_progress_for_product(p_username text, p_product_set_id integer)
returns table(product_set_id integer, product_name text, sport text, set_name text, editions_seen integer,
  players_seen integer, min_mint_cap integer, max_mint_cap integer, still_in_packs bigint, owned integer,
  missing integer, missing_asked integer, missing_unasked integer, cost_usd numeric, max_missing_ask_usd numeric,
  owner_last_seen_at timestamp with time zone)
language sql stable
set search_path = public
as $function$
  WITH eds AS (
    SELECT e.external_id, e.product_set_id, e.set_name, e.player_name, e.mint_cap, e.still_in_packs
    FROM panini_editions e
    WHERE e.set_name IS NOT NULL AND e.product_set_id = p_product_set_id
  ), asks AS (
    SELECT e.external_id AS edition_external_id, x.low_ask
    FROM eds e
    CROSS JOIN LATERAL (
      SELECT min(s.price_usd) AS low_ask
      FROM panini_card_serials s
      WHERE s.edition_external_id = e.external_id
        AND s.is_listed AND s.price_usd > 0 AND s.captured_at > now() - interval '7 days'
    ) x
    WHERE x.low_ask IS NOT NULL
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
  FROM eds e
  LEFT JOIN panini_products p ON p.set_id = e.product_set_id
  LEFT JOIN asks a ON a.edition_external_id = e.external_id
  LEFT JOIN mine m ON m.edition_external_id = e.external_id
  GROUP BY e.product_set_id, e.set_name
  ORDER BY count(*) DESC, e.set_name;
$function$;
revoke all on function public.panini_set_progress_for_product(text, integer) from public, anon, authenticated;
grant execute on function public.panini_set_progress_for_product(text, integer) to postgres, service_role;
comment on function public.panini_set_progress_for_product(text, integer) is
  'One Panini product''s set progress for the Sets tab (same columns as panini_set_progress_all, scoped before the work, low ask read per edition). 2026-11-10.';
