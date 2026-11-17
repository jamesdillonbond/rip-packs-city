-- pack_table_rows (read by the pack detail page + board) NULLs a Top Shot EV that balloons
-- past the live secondary ask (>3x), by adding the condition to the mv_pack_ev_latest LEFT
-- JOIN ON clause: a survivor-biased pack keeps its row (from pack_distributions) but its EV
-- columns become NULL -> page/board render the honest no-EV state. Reaches the actual
-- consumers (which read this view + the mv_pack_ev_latest matview). Reliable survivor-bias
-- signal = EV vs live ask (pack_ask_state, indexed); TS-scoped. Robust to which writer produced
-- the row (no purge whack-a-mole). Applied live via MCP (20260707153808). Per Trevor 2026-07-07.
-- Revert: restore the plain 2-predicate LEFT JOIN ON.
CREATE OR REPLACE VIEW public.pack_table_rows AS
 SELECT pd.dist_id,
    pd.collection_id,
    c.name AS collection_name,
        CASE
            WHEN c.name::text = 'NBA Top Shot'::text THEN 'nba-top-shot'::text
            WHEN c.name::text = 'NFL All Day'::text THEN 'nfl-all-day'::text
            WHEN c.name::text = 'LaLiga Golazos'::text THEN 'laliga-golazos'::text
            WHEN c.name::text = 'UFC Strike'::text THEN 'ufc-strike'::text
            ELSE lower(replace(c.name::text, ' '::text, '-'::text))
        END AS collection_slug,
    COALESCE(pd.title, pd.metadata ->> 'name'::text) AS title,
    COALESCE(pd.metadata ->> 'thumbnail'::text, pd.image_url) AS image_url,
    pd.nft_type,
    lower(pd.metadata ->> 'tier'::text) AS tier,
    pd.metadata ->> 'pack_type'::text AS pack_type,
    pd.metadata ->> 'description'::text AS description,
        CASE
            WHEN (pd.metadata ->> 'retail_price_usd'::text) IS NULL THEN NULL::numeric
            WHEN ((pd.metadata ->> 'retail_price_usd'::text)::numeric) >= 1000000::numeric THEN round(((pd.metadata ->> 'retail_price_usd'::text)::numeric) / 100000000::numeric, 2)
            ELSE round((pd.metadata ->> 'retail_price_usd'::text)::numeric, 2)
        END AS retail_price_usd,
    (pd.metadata ->> 'number_of_pack_slots'::text)::integer AS slots,
    pd.total_minted,
    pd.total_opened,
    pd.total_sealed,
    pd.depletion_pct,
    pev.pack_ev,
    pev.gross_ev,
    pev.pack_price AS ev_pack_price,
    pev.value_ratio,
    pev.is_positive_ev,
    pev.fmv_coverage_pct,
    pev.edition_count,
    pev.total_unopened,
    pev.depletion_pct AS ev_depletion_pct,
    pev.snapshotted_at AS ev_snapshotted_at,
        CASE
            WHEN pev.pack_ev IS NOT NULL AND pev.pack_price > 0::numeric THEN round(pev.pack_ev / pev.pack_price * 100::numeric, 1)
            ELSE NULL::numeric
        END AS ev_margin_pct,
    pd.first_seen_at,
    pd.updated_at,
        CASE
            WHEN pev.edition_count = 1 AND pev.pack_ev > 500::numeric THEN true
            ELSE false
        END AS is_rare_single_pack,
    pev.primary_price,
    pev.secondary_ask,
    pev.price_source,
    pev.primary_available,
    pev.secondary_available
   FROM pack_distributions pd
     JOIN collections c ON c.id = pd.collection_id
     LEFT JOIN mv_pack_ev_latest pev ON pev.dist_id = pd.dist_id AND pev.collection_id = pd.collection_id
       AND NOT (
         pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         AND EXISTS (
           SELECT 1 FROM pack_ask_state a
           WHERE a.collection_slug = 'nba-top-shot'
             AND a.dist_id = pev.dist_id
             AND a.is_listed IS TRUE
             AND a.lowest_ask > 0::numeric
             AND pev.gross_ev > 3::numeric * a.lowest_ask
         )
       );
