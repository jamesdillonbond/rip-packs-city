-- 2026-09-29 (PT): resolve_moment_id resolves a LIVE Top Shot listing (step 6a).
-- /insights/underpriced-serials links /moment/<nft_id> for every row on its board. A re-crawl after
-- the sales fallback (20260929260000) still found 2 of its links 404ing, and the table behind the
-- board had 388 of 973 rows (topshot_active_listings) that resolved nowhere: listed moments held by
-- untracked wallets, never sold, so in none of moments / wmc / cached_listings_v2 / sales. A 10 %
-- sample of the Atlas pool (ts_listings) showed the same: 1,286 of 3,256 flow ids unresolvable.
-- The listing knows the edition and the serial. Step 6a (before the sales step, after
-- cached_listings_v2): the board's own table first, then the Atlas pool, keyed set:play, or
-- set:play::parallel for a parallel (26,144 / 26,144 pool rows map to an edition that way).
-- Earlier steps still win (pin: 800800 stays on wmc's serial 5).
-- Cost: ts_listings had no flow_id index — a probe was a 1,824-buffer seq scan — so this adds
-- idx_ts_listings_flow_id (26k rows, 23 MB table; flow_id is not updated in place, so HOT survives).
-- Pinned: supabase/tests/resolve_moment_id.sql (6a arms). Old body fails it; a planted defect that
-- drops the ::parallel suffix fails it.
--
-- anon-exec: unchanged (resolve_moment_id) — CREATE OR REPLACE of an existing fn; ACL preserved; verified 2026-09-29 after apply via has_function_privilege.
--
-- Revert: DROP INDEX public.idx_ts_listings_flow_id; re-apply the body from
--         20260929260000_audit_20260929_resolve_moment_id_falls_back_to_sales.sql
CREATE INDEX IF NOT EXISTS idx_ts_listings_flow_id ON public.ts_listings (flow_id);

CREATE OR REPLACE FUNCTION public.resolve_moment_id(p_id text)
 RETURNS TABLE(kind text, moment_id uuid, edition_id uuid, serial_number integer, collection_id uuid, collection_slug text, pinnacle_edition_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uuid UUID;
  v_nft  BIGINT;
BEGIN
  RETURN QUERY
  SELECT 'pinnacle_edition'::TEXT,
         NULL::UUID,
         NULL::UUID,
         NULL::INT,
         (SELECT id FROM collections WHERE slug='disney_pinnacle'),
         'disney_pinnacle'::TEXT,
         pe.id
  FROM pinnacle_editions pe
  WHERE pe.id = p_id
  LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  BEGIN v_uuid := p_id::uuid; EXCEPTION WHEN OTHERS THEN v_uuid := NULL; END;

  IF v_uuid IS NOT NULL THEN
    RETURN QUERY
    SELECT 'moment'::TEXT, m.id, m.edition_id, m.serial_number,
           m.collection_id, c.slug::TEXT, NULL::TEXT
    FROM moments m
    JOIN collections c ON c.id = m.collection_id
    WHERE m.id = v_uuid
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    RETURN QUERY
    SELECT 'edition'::TEXT, NULL::UUID, e.id, NULL::INT,
           e.collection_id, c.slug::TEXT, NULL::TEXT
    FROM editions e
    JOIN collections c ON c.id = e.collection_id
    WHERE e.id = v_uuid
    LIMIT 1;
    RETURN;
  END IF;

  BEGIN v_nft := p_id::bigint; EXCEPTION WHEN OTHERS THEN v_nft := NULL; END;

  IF v_nft IS NOT NULL THEN
    RETURN QUERY
    SELECT 'moment'::TEXT, m.id, m.edition_id, m.serial_number,
           m.collection_id, c.slug::TEXT, NULL::TEXT
    FROM moments m
    JOIN collections c ON c.id = m.collection_id
    WHERE m.nft_id = v_nft::text
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- wmc fallback (2026-06-11): moments is a hydration cache and misses many
    -- held NFTs; wmc knows edition_key + serial for every tracked-wallet moment.
    -- Prefer Top Shot on cross-collection nft-id collisions; the editions join
    -- guarantees only resolvable rows return.
    RETURN QUERY
    SELECT 'moment'::TEXT, NULL::UUID, e.id, w.serial_number,
           w.collection_id, c.slug::TEXT, NULL::TEXT
    FROM wallet_moments_cache w
    JOIN collections c ON c.id = w.collection_id
    JOIN editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
    WHERE w.moment_id = p_id
    ORDER BY CASE WHEN w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN 0 ELSE 1 END
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- cached_listings_v2 fallback (2026-07-04): AllDay/Golazos secondary
    -- listings surface flow_ids for serials held by UNTRACKED wallets, so they
    -- are absent from both `moments` and `wallet_moments_cache` and the flat
    -- /moment/<flow_id> page 404'd on ~12k live AllDay listings. The live
    -- listing feed carries edition_id (direct FK to editions.id) but no serial,
    -- so resolve to the edition-level page (kind='edition') instead of a 404.
    -- Prefer an active listing, then the most recent, so a still-listed moment
    -- resolves before a completed one.
    RETURN QUERY
    SELECT 'edition'::TEXT, NULL::UUID, e.id, NULL::INT,
           e.collection_id, c.slug::TEXT, NULL::TEXT
    FROM cached_listings_v2 clv
    JOIN editions e ON e.id = clv.edition_id
    JOIN collections c ON c.id = e.collection_id
    WHERE clv.flow_id = v_nft
      AND clv.edition_id IS NOT NULL
    ORDER BY (clv.completed_at IS NULL) DESC, clv.listed_at DESC NULLS LAST
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- live Top Shot listings fallback (2026-09-29): /insights/underpriced-serials links /moment/<nft_id>
    -- for every listing on its board, and 388 of the 973 rows in topshot_active_listings resolved
    -- nowhere above (a listed moment held by an untracked wallet). The listing knows the edition and
    -- the serial: the board's own table first, then the Atlas pool (ts_listings, keyed set:play or
    -- set:play::parallel, verified 26,144 / 26,144 rows map to an edition). Probe on
    -- idx_ts_listings_flow_id; topshot_active_listings is ~1k rows.
    RETURN QUERY
    SELECT 'moment'::TEXT, NULL::UUID, x.edition_id, x.serial_number,
           c.id, c.slug::TEXT, NULL::TEXT
    FROM (
      SELECT tal.edition_id, tal.serial_number, 0 AS src, tal.last_seen_at AS seen
      FROM topshot_active_listings tal
      WHERE tal.nft_id = p_id AND tal.edition_id IS NOT NULL
      UNION ALL
      SELECT e.id, tl.serial_number, 1, tl.ingested_at
      FROM ts_listings tl
      JOIN editions e ON e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       AND e.external_id = tl.set_id || ':' || tl.play_id
                           || CASE WHEN COALESCE(tl.parallel_id, 0) <> 0 THEN '::' || tl.parallel_id ELSE '' END
      WHERE tl.flow_id = p_id
    ) x
    JOIN collections c ON c.id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    ORDER BY x.src, x.seen DESC NULLS LAST
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- sales fallback (2026-09-29): a SOLD moment now held by an untracked wallet is in none of
    -- moments / wmc / live listings, so the /moment/<nft_id> links the insights boards publish
    -- (top-sales, serial-premiums, underpriced-serials) 404'd: 24 of them on one crawl, every one
    -- carrying a sale with its edition. The sale knows the edition and the serial. Top Shot wins a
    -- cross-collection nft-id collision (the wmc step's rule), then the newest sale.
    RETURN QUERY
    SELECT 'moment'::TEXT, NULL::UUID, s.edition_id, s.serial_number,
           s.collection_id, c.slug::TEXT, NULL::TEXT
    FROM sales s
    JOIN collections c ON c.id = s.collection_id
    WHERE s.nft_id = p_id
      AND s.edition_id IS NOT NULL
    ORDER BY CASE WHEN s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN 0 ELSE 1 END,
             s.sold_at DESC
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- base58 fallback (2026-09-19): Candy MLB is on Solana, whose mint address is
  -- base58 -- not a uuid and not a bigint -- so a Candy /moment/<mint> URL fell
  -- through every branch above and 404'd. The wmc lookup that resolves it was
  -- ALREADY HERE and already text-keyed (`w.moment_id = p_id`); it was simply
  -- unreachable, sitting inside `IF v_nft IS NOT NULL` -- a bigint GATE in front
  -- of a text QUERY. Measured 2026-09-19: 6,847 distinct Candy sale mints, all
  -- resolvable through wmc (25,458 Candy wmc rows), while /insights/top-sales
  -- was publishing 7 Candy rows whose click-through was one of those 404s.
  --
  -- No Top Shot tie-break here, and none is needed: Flow nft_ids are numeric, so
  -- a base58 key cannot collide across chains. Ordered deterministically anyway
  -- so the returned row never depends on the plan. Measured over the whole
  -- base58 population: 0 moment_ids map to more than one (edition_key, serial).
  --
  -- Cost: one probe of idx_wmc_moment_collection_cover (moment_id, collection_id)
  -- INCLUDE (edition_key, serial_number) -- an existing covering index, so this
  -- adds no new index and no new scan shape (R46: a new read states its cost).
  IF p_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN
    RETURN QUERY
    SELECT 'moment'::TEXT, NULL::UUID, e.id, w.serial_number,
           w.collection_id, c.slug::TEXT, NULL::TEXT
    FROM wallet_moments_cache w
    JOIN collections c ON c.id = w.collection_id
    JOIN editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
    WHERE w.moment_id = p_id
    ORDER BY w.collection_id, w.edition_key, w.serial_number
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  RETURN;
END;
$function$;
