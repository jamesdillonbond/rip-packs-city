-- Give get_lock_check_batch a USER-WALLET priority tier.
--
-- anon-exec: public.get_lock_check_batch(text, integer, integer) -- unchanged ACL: postgres/service_role
-- only, no anon/authenticated EXECUTE. Signature is byte-identical, so no new overload is created and
-- the existing grants are preserved (verified before and after).
--
-- WHY (measured 2026-09-02, nba_top_shot, 24h):
--   lock-check-batch is green on every instrument -- 48/48 runs, 19,200 rows found, 19,184 written,
--   exactly its designed throughput. Those checks reached 12 distinct wallets, 69.2% of them ONE
--   wallet, 99.9% the top five. ALL TWELVE ARE SEEDED COVERAGE WALLETS. Meanwhile the 31 user wallets
--   (saved_wallets + linked_accounts) holding TopShot moments hold 212,201 rows, 100% of which qualify
--   for a check, and they received ZERO checks in 24h and 230 in 30 days.
--
--   The "priority" leg exists to favour wallets users care about and was sending 100% of its output to
--   coverage wallets. Cause: `hot` UNIONed seeded/saved/linked with NO PREFERENCE AMONG THEM, and with
--   1,474,231 rows carrying a NULL lock_checked_at every candidate TIES under
--   `ORDER BY lock_checked_at NULLS FIRST` -- so an unspecified tie-break decided 100% of targeting,
--   and seeded won on sheer mass (274 wallets with work vs 31; largest holds 21,124 moments).
--
-- THE CHANGE: carry is_user through hot -> cand -> dedup and rank on it FIRST.
--   1. `hot` becomes (addr, is_user); seeded => false, saved/linked => true.
--   2. The priority branch's OWN outer ORDER BY gains `is_user DESC`. This is LOAD-BEARING, not
--      cosmetic: that branch has its own LIMIT p_limit, so without it user rows are discarded there
--      before the final ranking ever sees them.
--   3. `dedup` adds bool_or(is_user); `ranked` orders is_user DESC, is_priority DESC, lock_checked_at.
--
-- NOT CHANGED, deliberately: throughput, batch size, cadence, the per-wallet inner LIMIT, and the
-- non-priority fallback leg. This changes WHO is served, not how much.
--
-- MEASURED BEFORE APPLYING (read-only, same literals): output went from 0/200 user rows to 200/200,
-- and the full shape cost 16,201 buffers -- no regression (the priority leg alone measured 21,725).
--
-- REVERT: re-apply the previous body, which is identical except that `hot` selects only `addr`, the
-- priority branch orders by `w2.lock_checked_at ASC NULLS FIRST` alone, `dedup` has no is_user, and
-- `ranked` orders by `is_priority DESC, lock_checked_at ASC NULLS FIRST`.
--
-- FALSIFIER, binding: verify on ROWS WRITTEN PER WALLET CLASS, never on `ok`. This pipeline has been
-- green and wrong for its entire life; a throughput arm cannot see a targeting failure. If within a
-- few ticks user wallets are still receiving 0 checks, this change did not work -- revert it rather
-- than rationalising.

CREATE OR REPLACE FUNCTION public.get_lock_check_batch(
  p_collection_slug text DEFAULT NULL::text,
  p_limit integer DEFAULT 50,
  p_max_age_days integer DEFAULT 7
)
RETURNS TABLE(
  out_wallet_address text,
  out_moment_id text,
  out_collection_id uuid,
  out_collection_slug text,
  out_edition_key text,
  out_is_priority boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $function$
  WITH hot AS (
    SELECT u.addr, bool_or(u.is_user) AS is_user
    FROM (
      SELECT seeded_wallets.wallet_address AS addr, false AS is_user FROM seeded_wallets
      UNION ALL
      SELECT saved_wallets.wallet_addr, true FROM saved_wallets
      UNION ALL
      SELECT linked_accounts.parent_addr, true FROM linked_accounts
      UNION ALL
      SELECT linked_accounts.child_addr, true FROM linked_accounts
    ) u
    GROUP BY u.addr
  ),
  cand AS (
    SELECT c.id AS cid, c.slug AS cslug,
           x.wallet_address, x.moment_id, x.edition_key, x.lock_checked_at,
           x.forced_priority, x.is_user
    FROM collections c
    CROSS JOIN LATERAL (
      ( SELECT w.wallet_address, w.moment_id, w.edition_key, w.lock_checked_at,
               false AS forced_priority, false AS is_user
        FROM wallet_moments_cache w
        WHERE w.collection_id = c.id
          AND (w.lock_checked_at IS NULL
               OR w.lock_checked_at < NOW() - (p_max_age_days || ' days')::interval)
        ORDER BY w.lock_checked_at ASC NULLS FIRST
        LIMIT p_limit )
      UNION ALL
      ( SELECT w2.wallet_address, w2.moment_id, w2.edition_key, w2.lock_checked_at,
               true AS forced_priority, h.is_user
        FROM hot h
        CROSS JOIN LATERAL (
          SELECT w.wallet_address, w.moment_id, w.edition_key, w.lock_checked_at
          FROM wallet_moments_cache w
          WHERE w.wallet_address = h.addr
            AND w.collection_id = c.id
            AND (w.lock_checked_at IS NULL
                 OR w.lock_checked_at < NOW() - (p_max_age_days || ' days')::interval)
          ORDER BY w.lock_checked_at ASC NULLS FIRST
          LIMIT p_limit
        ) w2
        ORDER BY h.is_user DESC, w2.lock_checked_at ASC NULLS FIRST
        LIMIT p_limit )
    ) x
    WHERE (p_collection_slug IS NULL OR c.slug = p_collection_slug)
  ),
  dedup AS (
    SELECT cand.wallet_address, cand.moment_id, cand.cid, cand.cslug, cand.edition_key,
           bool_or(cand.forced_priority) AS is_priority,
           bool_or(cand.is_user) AS is_user,
           min(cand.lock_checked_at) AS lock_checked_at
    FROM cand
    GROUP BY cand.wallet_address, cand.moment_id, cand.cid, cand.cslug, cand.edition_key
  ),
  ranked AS (
    SELECT dedup.wallet_address, dedup.moment_id, dedup.cid, dedup.cslug, dedup.edition_key,
           dedup.is_priority,
      ROW_NUMBER() OVER (
        PARTITION BY dedup.cid
        ORDER BY dedup.is_user DESC, dedup.is_priority DESC, dedup.lock_checked_at ASC NULLS FIRST
      ) AS rn
    FROM dedup
  )
  SELECT ranked.wallet_address, ranked.moment_id, ranked.cid, ranked.cslug,
         ranked.edition_key, ranked.is_priority
  FROM ranked
  ORDER BY ranked.rn, ranked.cid
  LIMIT p_limit;
$function$;

COMMENT ON FUNCTION public.get_lock_check_batch(text, integer, integer) IS
'Picks the next batch of wallet_moments_cache rows for an on-chain lock check.

RANKING (2026-09-02): is_user DESC, is_priority DESC, lock_checked_at ASC NULLS FIRST.

The is_user tier was added because the priority leg was sending 100% of its output to SEEDED coverage
wallets and 0% to user saved/linked wallets -- measured over 24h: 9,590 checks to 12 seeded wallets
(69% to one), while 31 user wallets holding 212,201 qualifying TopShot rows received zero. `hot` had
no preference among its sources, and with 1.47M NULL lock_checked_at values every candidate ties, so
the tie-break was the entire targeting algorithm and seeded won on mass.

DO NOT re-derive these, all measured 2026-09-02 and all worse:
  * wallet_address IN (SELECT ... FROM hot)  -> 631,906 buffers (hash join, materialises 1.86M rows)
  * wallet_address = ANY(array(...))         -> 565,784 buffers (full ordered index scan, no early exit)
  * the live per-wallet LATERAL               ->  21,725 buffers
Early termination would need a scan ordered globally by lock_checked_at, but wallet_address is not in
idx_wmc_lockcheck_order, so membership costs a heap visit per candidate and the planner will not pick it.

Do NOT lower the per-wallet inner LIMIT as an "optimisation": it is not exactness-preserving, because
one wallet can legitimately own all p_limit rows of the correct answer.

KNOWN AND NOT FIXED HERE: capacity. The 7-day freshness target implies ~271,000 checks/day; actual is
~9,590 (3.5%), and 1,474,231 TopShot rows have never been checked at all. p_max_age_days is therefore
INERT -- NULLs permanently sort ahead of any timestamped row, so nothing already checked is re-checked.
This function now sends scarce capacity to the right wallets; it does not create capacity.

Breadth WITHIN the user tier is an open question: with 31 user wallets, one wallet can still take a
whole batch. Capping per-wallet contribution would spread it, at the cost of exactness. Not decided.';