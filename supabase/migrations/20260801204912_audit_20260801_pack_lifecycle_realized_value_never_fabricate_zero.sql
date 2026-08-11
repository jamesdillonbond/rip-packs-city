-- audit_20260801_pack_lifecycle_realized_value_never_fabricate_zero
--
-- CAUSE (fabricated-data class — an ABSENT value printed as a real number)
--   /nba-top-shot/pack/dist/5643 rendered
--       "Realized pull value  $0.00  total, observed pulls"
--       "Avg / pack           $0.00  realized pull value"
--   for a pack with 69 observed opens and 276 moments pulled. The page's
--   fmtUsd() already renders NULL as an em-dash, so the zero came from the
--   DATABASE: both get_pack_lifecycle_row() and v_topshot_pack_lifecycle wrap
--   the realized sum in COALESCE(sum(pull_value_usd), 0), turning "we have not
--   priced any of these rips" into "these rips were worth nothing".
--
--   Second, subtler defect in the SAME expression: the average divided the
--   (possibly partial) priced sum by ALL opened packs
--       sum(pull_value_usd) / NULLIF(packs_opened, 0)
--   so on a partially-priced dist it is neither a population average nor a
--   sample average — it is systematically understated by the unpriced share.
--
-- EVIDENCE (measured 2026-08-01, live)
--   SELECT to_jsonb(t) FROM get_pack_lifecycle_row('5643') t;
--     -> packs_opened 69, moments_pulled 276,
--        realized_pull_value_usd 0, avg_realized_value_per_pack 0
--   Rips attributed to dist 5643: 69, of which pull_value_usd IS NOT NULL: 0.
--   Across Top Shot: pack_rips 821,835 rows, only 240,204 (29%) carry
--   pull_value_usd (the hourly backfill_pack_rip_metadata sweep cannot resolve
--   the rest). Of 2,191 attributed dists:
--     973  have ZERO priced rips  -> printed a fabricated $0.00 on both cells
--     871  are PARTIALLY priced   -> printed a diluted average
--     347  are fully priced       -> unaffected
--   v_allday_pack_lifecycle already returned NULL for the total (no COALESCE)
--   but shared the diluted-average denominator.
--
-- FIX
--   Never COALESCE an absent realized sum to 0, and divide by the number of
--   packs whose pull value we ACTUALLY have. Both figures become NULL when
--   nothing is priced, which the UI already renders as "—".
--   Function signature is unchanged (CREATE OR REPLACE, same RETURNS TABLE), so
--   grants are untouched. moments_pulled keeps its COALESCE — pack_rips.
--   moments_pulled is NOT NULL on all 821,835 rows, so it fabricates nothing.
--
-- REVERT SQL (exact): re-apply the three prior definitions --
--   1) get_pack_lifecycle_row: in the `o` CTE restore
--        COALESCE(sum(pull_value_usd), 0) AS realized_pull_value_usd
--      and in the final SELECT restore
--        round(o.realized_pull_value_usd, 2),
--        round(o.realized_pull_value_usd / NULLIF(o.packs_opened, 0)::numeric, 2),
--      (dropping the priced_packs column from the CTE).
--   2) v_topshot_pack_lifecycle: restore
--        round(COALESCE(o.realized_pull_value_usd, 0::numeric), 2) AS realized_pull_value_usd,
--        round(COALESCE(o.realized_pull_value_usd, 0::numeric) / NULLIF(o.packs_opened, 0)::numeric, 2) AS avg_realized_value_per_pack
--   3) v_allday_pack_lifecycle: restore
--        round(sum(r.pull_value_usd) / NULLIF(count(*), 0)::numeric, 2) AS avg_realized_value_per_pack
--   Each is a CREATE OR REPLACE; re-assert security_invoker + grants after (see
--   the ALTER/GRANT statements at the bottom of this migration).

CREATE OR REPLACE FUNCTION public.get_pack_lifecycle_row(p_dist_id text)
 RETURNS TABLE(packs_opened bigint, packs_opened_confirmed bigint, packs_opened_inferred bigint, packs_sealed_observed bigint, moments_pulled numeric, realized_pull_value_usd numeric, avg_realized_value_per_pack numeric, observed_depletion_pct numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH att AS (
    SELECT 'rip_dist'::text AS method, r.moments_pulled, r.pull_value_usd
    FROM pack_rips r
    WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND r.dist_id = p_dist_id
    UNION ALL
    SELECT a.method, r2.moments_pulled, r2.pull_value_usd
    FROM topshot_pack_rip_attribution a
    JOIN pack_rips r2 ON r2.id = a.rip_id
    WHERE a.dist_id = p_dist_id
      AND r2.dist_id IS NULL
      AND r2.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  ),
  o AS (
    SELECT count(*) AS packs_opened,
           count(*) FILTER (WHERE method = 'rip_dist') AS packs_opened_confirmed,
           count(*) FILTER (WHERE method <> 'rip_dist') AS packs_opened_inferred,
           COALESCE(sum(moments_pulled), 0) AS moments_pulled,
           -- NO COALESCE: NULL means "none of these rips has a priced pull",
           -- which is not the same claim as "the pulls were worth $0".
           sum(pull_value_usd) AS realized_pull_value_usd,
           -- Denominator = packs we could actually price, not every opened pack.
           count(pull_value_usd) AS priced_packs
    FROM att
  ),
  s AS (
    SELECT count(DISTINCT p.pack_nft_id) AS packs_sealed_observed
    FROM pack_purchases p
    WHERE p.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND p.pack_dist_id = p_dist_id
      AND NOT EXISTS (SELECT 1 FROM pack_rips r WHERE r.collection_id = p.collection_id AND r.pack_nft_id = p.pack_nft_id)
  )
  SELECT o.packs_opened, o.packs_opened_confirmed, o.packs_opened_inferred,
         s.packs_sealed_observed,
         o.moments_pulled::numeric,
         round(o.realized_pull_value_usd, 2),
         round(o.realized_pull_value_usd / NULLIF(o.priced_packs, 0)::numeric, 2),
         CASE WHEN (o.packs_opened + s.packs_sealed_observed) > 0
              THEN round(100.0 * o.packs_opened::numeric / (o.packs_opened + s.packs_sealed_observed)::numeric)
         END
  FROM o, s;
$function$;

COMMENT ON FUNCTION public.get_pack_lifecycle_row(text) IS
  'Per-dist Top Shot observed pack lifecycle. realized_pull_value_usd / avg_realized_value_per_pack are NULL (not 0) when no attributed rip carries a pull value, and the average is over PRICED packs only. See audit_20260801_pack_lifecycle_realized_value_never_fabricate_zero.';

CREATE OR REPLACE VIEW public.v_topshot_pack_lifecycle AS
 WITH att AS (
         SELECT COALESCE(r.dist_id, a.dist_id) AS dist_id,
                CASE
                    WHEN r.dist_id IS NOT NULL THEN 'rip_dist'::text
                    ELSE a.method
                END AS method,
            r.moments_pulled,
            r.pull_value_usd,
            r.sealed_at
           FROM pack_rips r
             LEFT JOIN topshot_pack_rip_attribution a ON a.rip_id = r.id
          WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND (r.dist_id IS NOT NULL OR a.dist_id IS NOT NULL)
        ), opened AS (
         SELECT att.dist_id,
            count(*) AS packs_opened,
            count(*) FILTER (WHERE att.method = 'rip_dist'::text) AS packs_opened_confirmed,
            count(*) FILTER (WHERE att.method <> 'rip_dist'::text) AS packs_opened_inferred,
            sum(att.moments_pulled) AS moments_pulled,
            sum(att.pull_value_usd) AS realized_pull_value_usd,
            count(att.pull_value_usd) AS priced_packs,
            count(*) FILTER (WHERE att.sealed_at > (now() - '7 days'::interval)) AS opened_7d,
            count(*) FILTER (WHERE att.sealed_at > (now() - '30 days'::interval)) AS opened_30d,
            min(att.sealed_at) AS first_open_at,
            max(att.sealed_at) AS last_open_at
           FROM att
          GROUP BY att.dist_id
        ), sealed AS (
         SELECT p.pack_dist_id AS dist_id,
            count(DISTINCT p.pack_nft_id) AS packs_sealed_observed
           FROM pack_purchases p
          WHERE p.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND p.pack_dist_id IS NOT NULL AND NOT (EXISTS ( SELECT 1
                   FROM pack_rips r
                  WHERE r.collection_id = p.collection_id AND r.pack_nft_id = p.pack_nft_id))
          GROUP BY p.pack_dist_id
        ), ev1 AS (
         SELECT DISTINCT ON (pack_ev_latest.dist_id) pack_ev_latest.dist_id,
            pack_ev_latest.total_unopened,
            pack_ev_latest.depletion_pct,
            pack_ev_latest.pack_price
           FROM pack_ev_latest
          WHERE pack_ev_latest.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
          ORDER BY pack_ev_latest.dist_id, pack_ev_latest.snapshotted_at DESC
        )
 SELECT d.dist_id,
    d.title,
        CASE
            WHEN NULLIF(d.metadata ->> 'retail_price_usd'::text, ''::text)::numeric >= 1000000::numeric THEN round(NULLIF(d.metadata ->> 'retail_price_usd'::text, ''::text)::numeric * 0.00000001, 2)
            ELSE NULLIF(d.metadata ->> 'retail_price_usd'::text, ''::text)::numeric
        END AS retail_price_usd,
    NULLIF(d.metadata ->> 'number_of_pack_slots'::text, ''::text)::integer AS pack_slots,
    COALESCE(o.packs_opened, 0::bigint) AS packs_opened,
    COALESCE(o.packs_opened_confirmed, 0::bigint) AS packs_opened_confirmed,
    COALESCE(o.packs_opened_inferred, 0::bigint) AS packs_opened_inferred,
    COALESCE(s.packs_sealed_observed, 0::bigint) AS packs_sealed_observed,
    COALESCE(o.packs_opened, 0::bigint) + COALESCE(s.packs_sealed_observed, 0::bigint) AS packs_observed_total,
    COALESCE(o.moments_pulled, 0::bigint) AS moments_pulled,
    round(o.realized_pull_value_usd, 2) AS realized_pull_value_usd,
    round(o.realized_pull_value_usd / NULLIF(o.priced_packs, 0)::numeric, 2) AS avg_realized_value_per_pack,
        CASE
            WHEN (COALESCE(o.packs_opened, 0::bigint) + COALESCE(s.packs_sealed_observed, 0::bigint)) > 0 THEN round(100.0 * COALESCE(o.packs_opened, 0::bigint)::numeric / (COALESCE(o.packs_opened, 0::bigint) + COALESCE(s.packs_sealed_observed, 0::bigint))::numeric)
            ELSE NULL::numeric
        END AS observed_depletion_pct,
    COALESCE(o.opened_7d, 0::bigint) AS opened_7d,
    COALESCE(o.opened_30d, 0::bigint) AS opened_30d,
    o.first_open_at,
    o.last_open_at,
    ev1.total_unopened AS sealed_live,
    ev1.depletion_pct AS depletion_pct_live,
    ev1.pack_price AS pack_price_live,
        CASE
            WHEN tps.supply_ok THEN tps.total_minted
            ELSE NULL::integer
        END AS minted_true,
    COALESCE(ev1.total_unopened,
        CASE
            WHEN tps.supply_ok THEN tps.total_sealed
            ELSE NULL::integer
        END) AS sealed_best,
    COALESCE(ev1.depletion_pct,
        CASE
            WHEN tps.supply_ok THEN tps.depletion_pct
            ELSE NULL::smallint
        END) AS depletion_best
   FROM pack_distributions d
     LEFT JOIN opened o ON o.dist_id = d.dist_id
     LEFT JOIN sealed s ON s.dist_id = d.dist_id
     LEFT JOIN ev1 ON ev1.dist_id = d.dist_id
     LEFT JOIN topshot_pack_supply tps ON tps.dist_id = d.dist_id
  WHERE d.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid;

CREATE OR REPLACE VIEW public.v_allday_pack_lifecycle AS
 WITH opened AS (
         SELECT r.dist_id,
            count(*) AS packs_opened,
            sum(r.moments_pulled) AS moments_pulled,
            round(sum(r.pull_value_usd), 2) AS realized_pull_value_usd,
            -- Denominator = packs we could actually price (was count(*), which
            -- understated every partially-priced dist).
            round(sum(r.pull_value_usd) / NULLIF(count(r.pull_value_usd), 0)::numeric, 2) AS avg_realized_value_per_pack,
            count(*) FILTER (WHERE r.sealed_at > (now() - '7 days'::interval)) AS opened_7d,
            count(*) FILTER (WHERE r.sealed_at > (now() - '30 days'::interval)) AS opened_30d,
            min(r.sealed_at) AS first_open_at,
            max(r.sealed_at) AS last_open_at
           FROM pack_rips r
          WHERE r.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND r.dist_id IS NOT NULL
          GROUP BY r.dist_id
        )
 SELECT d.dist_id,
    COALESCE(d.title, d.metadata ->> 'name'::text) AS title,
    s.total_minted AS minted,
    s.slots,
    COALESCE(o.packs_opened, 0::bigint) AS packs_opened,
    COALESCE(o.moments_pulled, 0::bigint) AS moments_pulled,
    o.realized_pull_value_usd,
    o.avg_realized_value_per_pack,
        CASE
            WHEN s.total_minted > 0 AND o.packs_opened IS NOT NULL THEN round(100.0 * o.packs_opened::numeric / s.total_minted::numeric, 2)
            ELSE NULL::numeric
        END AS opened_pct_of_minted,
    COALESCE(o.opened_7d, 0::bigint) AS opened_7d,
    COALESCE(o.opened_30d, 0::bigint) AS opened_30d,
    o.first_open_at,
    o.last_open_at
   FROM pack_distributions d
     LEFT JOIN allday_pack_supply s ON s.dist_id = d.dist_id
     LEFT JOIN opened o ON o.dist_id = d.dist_id
  WHERE d.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;

-- CREATE OR REPLACE VIEW wipes reloptions and does not restore grants.
ALTER VIEW public.v_topshot_pack_lifecycle SET (security_invoker = on);
ALTER VIEW public.v_allday_pack_lifecycle  SET (security_invoker = on);
GRANT SELECT ON public.v_topshot_pack_lifecycle TO anon, authenticated, service_role;
GRANT SELECT ON public.v_allday_pack_lifecycle  TO anon, authenticated, service_role;
