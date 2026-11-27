-- audit_20261127_offer_seen_stamp_skips_rows_restamped_within_3h — 2026-11-27 ~8:45 AM PT (Claude cloud).
-- Follow-up to 20261127162858. Its first pg_cron run (8:38 AM PT) took 40 s and rewrote 2,984 rows: every
-- bid confirmed by an open CHAIN offer is stamped now(), so it changed on every run. A stamp the same
-- amount already carries from within 3 h is left alone: the view's window is 24 h and the X draft's 6 h,
-- so a 3 h refresh keeps both. A changed amount still re-stamps on the next run; a newer sighting of the
-- same bid lands within 3 h.
-- Revert: re-run cron.alter_job(942, command := <the 20261127162858 command>).
select cron.alter_job((select jobid from cron.job where jobname = 'rpc-edition-offer-seen-stamp'), command := $cmd$UPDATE public.edition_offers t
   SET highest_offer_seen_at = s.seen_at, highest_offer_seen_amount = s.highest_offer
  FROM (
    SELECT eo.external_id, eo.highest_offer, GREATEST(a.seen, c.seen) AS seen_at
      FROM public.edition_offers eo
      LEFT JOIN public.topshot_atlas_edition_map m ON m.external_id = eo.external_id
      LEFT JOIN LATERAL (
        SELECT max(ev.last_seen_at) AS seen FROM public.topshot_atlas_market_events ev
         WHERE ev.product = 'nba' AND ev.atlas_edition_id = m.atlas_edition_id AND ev.kind = 'offer' AND NOT ev.completed
           AND ev.offer_type IN ('EDITION','PARALLEL') AND ev.price_cents = (eo.highest_offer * 100)::bigint) a ON true
      LEFT JOIN LATERAL (
        SELECT now() AS seen
          FROM public.editions e2
          JOIN public.offers o ON o.edition_id = e2.id AND o.collection_id = e2.collection_id
         WHERE e2.collection_id = eo.collection_id AND e2.external_id::text = eo.external_id
           AND o.status = 'open' AND o.offer_type = 'edition' AND o.offer_amount_usd = eo.highest_offer
           AND NOT (EXISTS (SELECT 1 FROM public.topshot_atlas_edition_verified v
                             WHERE v.atlas_edition_id = m.atlas_edition_id AND v.verified_at > o.created_at)
                    AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev2
                             WHERE ev2.product = 'nba' AND ev2.atlas_edition_id = m.atlas_edition_id
                               AND ev2.kind = 'offer' AND NOT ev2.completed AND ev2.listing_resource_id = o.offer_id))
         LIMIT 1) c ON true
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.highest_offer > 0
  ) s
 WHERE t.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND t.external_id = s.external_id
   AND (t.highest_offer_seen_at IS DISTINCT FROM s.seen_at OR t.highest_offer_seen_amount IS DISTINCT FROM s.highest_offer)
   AND NOT (t.highest_offer_seen_amount = s.highest_offer AND t.highest_offer_seen_at > s.seen_at - interval '3 hours')$cmd$);
