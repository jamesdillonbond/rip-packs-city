-- audit_20260919_resolve_moment_id_resolves_a_base58_mint
--
-- CAUSE. public.resolve_moment_id walks three key spaces: a Pinnacle render id
-- (text), a uuid, and an on-chain nft/flow id parsed as BIGINT. Candy MLB is on
-- Solana, where a mint address is base58 -- neither uuid nor bigint -- so every
-- Candy /moment/<mint> URL fell past all three branches and returned no rows,
-- which app/moment/[id]/layout.tsx turns into a real 404.
--
-- The sharp part: the query that resolves these was ALREADY IN THIS FUNCTION and
-- was already TEXT-KEYED (`WHERE w.moment_id = p_id`). It was unreachable only
-- because it sits inside `IF v_nft IS NOT NULL` -- a bigint gate in front of a
-- text query. This migration does not add a lookup; it makes the existing one
-- reachable for the key shape it was always able to answer.
--
-- EVIDENCE (measured 2026-09-19, PT):
--   * /insights/top-sales is public and 200, and v_insights_top_sales carries 7
--     Candy rows in the 30d window. Every one has an nft_id, so the board's
--     rowHref() sends the reader to /moment/<base58>.
--     Probed live: /moment/24XCd26urKPWKBfjqwcep6qk7kMRQ21XkAEWBxUSmDCN -> 404,
--                  /moment/Gf2g1FAKJNWArEYBt6NL6EVJvvsR3LqCpqtHwN5czWmG -> 404.
--   * 6,847 distinct Candy sale mints exist; the wmc join resolves them
--     (25,458 Candy wallet_moments_cache rows, moment_id = the base58 mint).
--   * Three sampled mints resolve to the right edition AND the right serial
--     (2 / 9 / 1), matching the serial on the sale row.
--   * Ambiguity check over the whole base58 population: 0 moment_ids map to
--     more than one (edition_key, serial_number). The LIMIT 1 cannot pick wrong.
--
-- COST. One probe of the existing covering index
-- idx_wmc_moment_collection_cover (moment_id, collection_id) INCLUDE
-- (edition_key, serial_number). No new index, no new scan shape, and the branch
-- is shape-gated so it never runs for a Flow id. (R46: the instance's IO budget
-- is at 100% by choice, so a new read states what it costs.)
--
-- SAFETY. Strictly ADDITIVE and unreachable for every existing key shape: the
-- new branch is guarded by `p_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`, and the
-- base58 alphabet excludes 0/O/I/l, so a bigint id can never match it (a 32-44
-- digit number contains no letters but would need 32+ digits; the existing
-- bigint branch has already RETURNed for any parseable id, and an unparseable
-- 32+ digit string is not a live key). Every prior branch is byte-identical to
-- the pin that CI holds; the diff is one IF block appended before the terminal
-- RETURN.
--
-- anon-exec: intentional -- resolve_moment_id keeps its existing ACL, because
-- CREATE OR REPLACE FUNCTION does not reset one and the signature is unchanged.
-- ⚠ The marker name must sit on the SAME LINE as `anon-exec:` -- the guard's
-- predicate is one .some() testing both on a single line, and a name on the
-- next line fails identically to no marker at all (ledger, 2026-09-19 AM).
-- Verified live BEFORE this migration with has_function_privilege rather than
-- acl text: anon EXECUTE false, authenticated EXECUTE false, service_role
-- EXECUTE true. No grant is made here and none is intended; the /moment/<id>
-- route reads this through the service-role client. Re-verified after applying:
-- anon false, service_role true, check_secdef_anon_exec_drift() length 0.
--
-- REVERT (exact): re-apply the function body from
-- supabase/migrations/20260704020000_audit_20260704_resolve_moment_id_cached_listings_fallback.sql
-- verbatim -- i.e. the same CREATE OR REPLACE below with the final
-- `IF p_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN ... END IF;` block deleted.
-- No data is written by this function, so the revert is complete.

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
