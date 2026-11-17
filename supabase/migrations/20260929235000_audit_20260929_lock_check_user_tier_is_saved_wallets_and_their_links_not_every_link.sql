-- audit_20260929_lock_check_user_tier_is_saved_wallets_and_their_links_not_every_link
-- anon-exec: unchanged (get_lock_check_batch) — CREATE OR REPLACE of an existing fn, identical signature and RETURNS TABLE; ACL preserved, verified has_function_privilege anon=false, authenticated=false, service_role=true (2026-09-29).
--
-- WHAT BROKE (today, by the linked_accounts backfill)
-- get_lock_check_batch's `hot` set put EVERY linked_accounts address (both
-- sides) in the USER tier. The 2026-09-02 fix meant "wallets users saved or
-- linked"; but linked_accounts holds any chain account with a Hybrid Custody
-- link, not RPC users. It was 217 rows; the 2026-09-29 child-side backfill
-- made it 1,319 (1,941 addresses new to the tier, 203 of them holding 33,671
-- wmc rows). Inside the tier the order is lock_checked_at NULLS FIRST, so a
-- trader's never-checked rows beat every saved wallet's:
--
--     get_lock_check_batch('nba_top_shot', 1000, 7), measured 2026-09-29 ~4:20 PM PT
--       live : 1,000 / 1,000 rows -> ONE linked-only trader wallet, 0 to saved wallets
--       new  : 1,000 / 1,000 rows -> 3 saved wallets
--
-- THE CHANGE (the `hot` CTE only; every other line is the live body verbatim,
-- base = 20260902035016, prosrc md5 5b625aaee9ff6b8c25a7f3d68c9fb6aa):
-- the user tier is saved_wallets plus the ACTIVE Hybrid Custody counterpart of
-- a saved wallet (its parents if it is a child, its children if a parent).
-- Linked-only accounts drop out of `hot` and get background coverage like any
-- other wmc row. Inactive links no longer count.
--
-- COST, same harness (EXPLAIN ANALYZE of the function call, warm, 2 runs each):
--     live 47,303-48,683 shared buffers, 236-402 ms
--     new  35,949-35,969 shared buffers, 217-235 ms
--
-- Revert: re-apply the CREATE OR REPLACE from 20260902035016.

CREATE OR REPLACE FUNCTION public.get_lock_check_batch(p_collection_slug text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_max_age_days integer DEFAULT 7)
 RETURNS TABLE(out_wallet_address text, out_moment_id text, out_collection_id uuid, out_collection_slug text, out_edition_key text, out_is_priority boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
  WITH saved AS (
    SELECT saved_wallets.wallet_addr AS addr FROM saved_wallets WHERE saved_wallets.wallet_addr IS NOT NULL
  ),
  hot AS (
    -- User tier = SAVED wallets and their ACTIVE Hybrid Custody counterparts, never
    -- every linked address: linked_accounts holds any chain account with a link
    -- (1,319 rows after the 2026-09-29 child-side backfill), and putting all of
    -- them in the user tier handed a whole Top Shot batch to one trader wallet.
    SELECT u.addr, bool_or(u.is_user_wallet) AS is_user_wallet
    FROM (
      SELECT seeded_wallets.wallet_address AS addr, false AS is_user_wallet FROM seeded_wallets
      UNION ALL
      SELECT saved.addr, true FROM saved
      UNION ALL
      SELECT l.parent_addr, true FROM linked_accounts l JOIN saved ON saved.addr = l.child_addr WHERE l.active
      UNION ALL
      SELECT l.child_addr, true FROM linked_accounts l JOIN saved ON saved.addr = l.parent_addr WHERE l.active
    ) u
    WHERE u.addr IS NOT NULL
    GROUP BY u.addr
  ),
  cand AS (
    SELECT c.id AS cid, c.slug AS cslug,
           x.wallet_address, x.moment_id, x.edition_key, x.lock_checked_at, x.forced_priority,
           x.is_user_wallet
    FROM collections c
    CROSS JOIN LATERAL (
      ( SELECT w.wallet_address, w.moment_id, w.edition_key, w.lock_checked_at,
               false AS forced_priority, false AS is_user_wallet
        FROM wallet_moments_cache w
        WHERE w.collection_id = c.id
          AND (w.lock_checked_at IS NULL
               OR w.lock_checked_at < NOW() - (p_max_age_days || ' days')::interval)
        ORDER BY w.lock_checked_at ASC NULLS FIRST
        LIMIT p_limit )
      UNION ALL
      ( SELECT w2.wallet_address, w2.moment_id, w2.edition_key, w2.lock_checked_at,
               true AS forced_priority, w2.is_user_wallet
        FROM hot h
        CROSS JOIN LATERAL (
          SELECT w.wallet_address, w.moment_id, w.edition_key, w.lock_checked_at,
                 h.is_user_wallet
          FROM wallet_moments_cache w
          WHERE w.wallet_address = h.addr
            AND w.collection_id = c.id
            AND (w.lock_checked_at IS NULL
                 OR w.lock_checked_at < NOW() - (p_max_age_days || ' days')::interval)
          ORDER BY w.lock_checked_at ASC NULLS FIRST
          LIMIT p_limit
        ) w2
        ORDER BY w2.is_user_wallet DESC, w2.lock_checked_at ASC NULLS FIRST
        LIMIT p_limit )
    ) x
    WHERE (p_collection_slug IS NULL OR c.slug = p_collection_slug)
  ),
  dedup AS (
    SELECT cand.wallet_address, cand.moment_id, cand.cid, cand.cslug, cand.edition_key,
           bool_or(cand.forced_priority) AS is_priority,
           bool_or(cand.is_user_wallet) AS is_user_wallet,
           min(cand.lock_checked_at) AS lock_checked_at
    FROM cand
    GROUP BY cand.wallet_address, cand.moment_id, cand.cid, cand.cslug, cand.edition_key
  ),
  ranked AS (
    SELECT dedup.wallet_address, dedup.moment_id, dedup.cid, dedup.cslug, dedup.edition_key, dedup.is_priority,
      ROW_NUMBER() OVER (
        PARTITION BY dedup.cid
        ORDER BY dedup.is_priority DESC, dedup.is_user_wallet DESC, dedup.lock_checked_at ASC NULLS FIRST
      ) AS rn
    FROM dedup
  )
  SELECT ranked.wallet_address, ranked.moment_id, ranked.cid, ranked.cslug, ranked.edition_key, ranked.is_priority
  FROM ranked
  ORDER BY ranked.rn, ranked.cid
  LIMIT p_limit;
$function$;
