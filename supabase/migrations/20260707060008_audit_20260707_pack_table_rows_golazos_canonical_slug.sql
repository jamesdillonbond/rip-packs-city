-- pack_table_rows emitted 'la-liga-golazos' for LaLiga Golazos, which does NOT
-- match the frontend/registry slug 'laliga-golazos' (lib/collections.ts), so the
-- /api/packs filter .eq('collection_slug','laliga-golazos') returned 0 rows even
-- though 16 priced Golazos packs exist in mv_pack_ev_latest. Every other
-- collection's emitted slug already matches its registry id; Golazos was the lone
-- special-case bug. Emit the canonical slug so the Golazos packs surface can wire
-- exactly like Pinnacle with no special-casing. Nothing else references the old
-- string (grep of code + pg_proc + views = only this view).
-- Revert: set the Golazos branch back to 'la-liga-golazos'::text.
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
     LEFT JOIN mv_pack_ev_latest pev ON pev.dist_id = pd.dist_id AND pev.collection_id = pd.collection_id;
