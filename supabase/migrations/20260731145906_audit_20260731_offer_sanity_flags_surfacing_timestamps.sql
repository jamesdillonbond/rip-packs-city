-- audit_20260731_offer_sanity_flags_surfacing_timestamps
--
-- RECOVERED 2026-07-31 (PT) from supabase_migrations.schema_migrations version
-- 20260731145906, verbatim. Applied via Supabase MCP with no repo file and no
-- ledger entry. Adds the two trailing timestamp columns that
-- audit_20260731_offer_gap_metric_excludes_inflight_sweep_window depends on --
-- file/apply order matters. See docs/overnight/ledger.md 2026-07-31.
--
-- Revert: re-create v_offer_sanity_flags without top_offer_created_at and
-- offers_refreshed_at, but ONLY after reverting the offer-gap metric arm that
-- reads them (audit_20260731_offer_gap_metric_excludes_inflight_sweep_window).

-- Additive only: same row set, same leading columns, two new trailing columns.
-- They let the trust metric tell "the sweep ran and is still wrong" (a real
-- surfacing failure) apart from "the sweep has not reached this edition yet"
-- (in-flight latency). Every edition-grain flag observed 2026-07-31 was the
-- latter: all five top offers were 7-15 min old and offers-sweep runs every
-- 20 min with 0 failures in 24h.
CREATE OR REPLACE VIEW public.v_offer_sanity_flags AS
 WITH onchain AS (
         SELECT o.edition_id,
            max(o.offer_amount_usd) AS chain_max_offer,
            count(*) AS chain_open_offers,
            bool_or(o.offer_type::text = ANY (ARRAY['subedition'::character varying, 'serial'::character varying]::text[])) AS has_sub_serial,
            (array_agg(o.created_at ORDER BY o.offer_amount_usd DESC, o.created_at DESC))[1] AS top_offer_created_at
           FROM offers o
          WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND o.status::text = 'open'::text
          GROUP BY o.edition_id
        )
 SELECT e.external_id,
    e.player_name,
    e.name AS edition_name,
    oc.chain_open_offers,
    oc.has_sub_serial,
    oc.chain_max_offer,
    eo.highest_offer AS gql_highest_offer,
        CASE
            WHEN eo.highest_offer IS NULL THEN 'gql_blank_chain_has'::text
            WHEN oc.chain_max_offer > (eo.highest_offer + 0.01) THEN 'chain_exceeds_gql'::text
            ELSE 'ok'::text
        END AS flag,
    round(oc.chain_max_offer - COALESCE(eo.highest_offer, 0::numeric), 2) AS gap_usd,
    oc.top_offer_created_at,
    eo.updated_at AS offers_refreshed_at
   FROM onchain oc
     JOIN editions e ON e.id = oc.edition_id
     LEFT JOIN edition_offers eo ON eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND eo.external_id = e.external_id::text
  WHERE eo.highest_offer IS NULL OR oc.chain_max_offer > (eo.highest_offer + 0.01);

ALTER VIEW public.v_offer_sanity_flags SET (security_invoker = on);
REVOKE ALL ON public.v_offer_sanity_flags FROM anon;

COMMENT ON VIEW public.v_offer_sanity_flags IS
'Editions where the on-chain open-offer max exceeds the surfaced edition_offers.highest_offer.
Read the two trailing columns before treating a row as a defect: if offers_refreshed_at <= top_offer_created_at, offers-sweep simply has not reached this edition since the offer landed -- that is latency, not a miss. A real surfacing failure is offers_refreshed_at > top_offer_created_at (swept, still wrong), or a top offer older than the sweep cadence with no refresh at all (sweep stalled). offer_edition_gap_max_usd applies exactly that pair of tests.
has_sub_serial=true rows are serial/subedition-grain offers that are not comparable at edition grain; the trust metric excludes them by design (920 flagged, 839 older than 2h, max gap $1,552 on 2026-07-31 -- all expected).';
