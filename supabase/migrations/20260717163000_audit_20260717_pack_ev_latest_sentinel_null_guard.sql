-- H1: pack_ev_latest emitted raw sentinel rows (gross_ev=0 AND edition_count=0)
-- carrying the pack's real price. Downstream get_pack_realized_ev_row read
-- gross_ev=0 (not NULL) -> wrong blend branch + a false $0 modeled EV that hid
-- the "EV reality check" panel for 196 live-priced TS packs; refresh_challenge_costs
-- COALESCE'd a false $0 reward value. Guard the EV-derived columns to NULL on the
-- sentinel shape, mirroring pack_table_rows. Rows are NOT filtered out (packs keep
-- their real live price). get_pack_market_row reads pack_price only -> unaffected.
-- Revert: recreate the prior (un-guarded) view def from migration history.
CREATE OR REPLACE VIEW public.pack_ev_latest AS
 SELECT DISTINCT ON (pack_listing_id) pack_listing_id,
    collection_id,
    dist_id,
    pack_name,
    pack_price,
    (CASE WHEN gross_ev = 0 AND edition_count = 0 THEN NULL ELSE gross_ev END)::numeric(10,2) AS gross_ev,
    (CASE WHEN gross_ev = 0 AND edition_count = 0 THEN NULL ELSE pack_ev END)::numeric(10,2) AS pack_ev,
    (CASE WHEN gross_ev = 0 AND edition_count = 0 THEN NULL ELSE is_positive_ev END)::boolean AS is_positive_ev,
    (CASE WHEN gross_ev = 0 AND edition_count = 0 THEN NULL ELSE value_ratio END)::numeric(12,4) AS value_ratio,
    (CASE WHEN gross_ev = 0 AND edition_count = 0 THEN NULL ELSE fmv_coverage_pct END)::smallint AS fmv_coverage_pct,
    edition_count,
    total_unopened,
    (CASE WHEN gross_ev = 0 AND edition_count = 0 THEN NULL ELSE depletion_pct END)::smallint AS depletion_pct,
    snapshotted_at,
    primary_price,
    secondary_ask,
    price_source,
    primary_available,
    secondary_available,
    (CASE WHEN gross_ev = 0 AND edition_count = 0 THEN NULL ELSE typical_ev END)::numeric(10,2) AS typical_ev
   FROM pack_ev_history
  WHERE pack_ev >= '-10000'::integer::numeric AND pack_ev <= 1000000::numeric AND pack_price > 0::numeric AND pack_name !~~ 'Holding %'::text
    AND NOT (collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND (EXISTS ( SELECT 1
           FROM pack_ask_state a
          WHERE a.collection_slug = 'nba-top-shot'::text AND a.dist_id = pack_ev_history.dist_id AND a.is_listed IS TRUE AND a.lowest_ask > 0::numeric AND pack_ev_history.gross_ev > (3::numeric * a.lowest_ask))))
  ORDER BY pack_listing_id, snapshotted_at DESC;
