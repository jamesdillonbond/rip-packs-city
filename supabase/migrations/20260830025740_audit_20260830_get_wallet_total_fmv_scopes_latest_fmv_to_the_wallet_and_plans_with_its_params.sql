-- audit_20260830_get_wallet_total_fmv_scopes_latest_fmv_to_the_wallet_and_plans_with_its_params
--
-- WHY: /api/collection-moments calls get_wallet_total_fmv on EVERY wallet page. Measured
-- 2026-08-30 02:5xZ on the 15,181-moment Top Shot wallet 0xbd94cade097e50ac:
-- 1,367,569 shared buffers, 8.1 s — TEN TIMES the moments query on the same page. On the
-- 1,599-moment All Day slice of 0x0d744d23165bfb6c (a 155k-moment wallet) the live function
-- hit its own 30 s statement_timeout — twice — so the route's `.catch(() => 0)` rendered a
-- $0 headline for that collector. Two mechanisms, both param-blind planning:
--
--   (1) `latest_fmv AS (SELECT DISTINCT ON (edition_id) ... FROM fmv_snapshots)` is a full
--       DISTINCT ON over every snapshot row (1.33M in fmv_snapshots_2026) for every call,
--       whatever the wallet holds — and it is referenced twice, so it is materialised.
--   (2) LANGUAGE sql => planned with boundParams = NULL (generic plan) on PG 17, so
--       `(p_collection_id IS NULL OR wmc.collection_id = p_collection_id)` becomes a
--       FILTER under an index scan on wallet_address alone: the All Day call read all
--       155,411 of that wallet's rows (Rows Removed by Filter: 153,812; 87k disk reads,
--       45.5 s in a force_generic_plan emulation). A custom plan puts collection_id in
--       the Index Cond of idx_wmc_lock_wallet_coll: 6,168 buffers, 211 ms.
--
-- FIX: (1) compute the latest snapshot per edition with a LATERAL ... ORDER BY computed_at
-- DESC LIMIT 1 on the wallet's own editions (and, for the sibling arm, on the sibling
-- editions only), and (2) LANGUAGE plpgsql + plan_cache_mode=force_custom_plan so the
-- statement is planned with the real wallet/collection values every call.
--
-- SEMANTICS PRESERVED (the pinned 3-tier COALESCE, see supabase/tests/get_wallet_total_fmv.sql):
--   tier 1: the edition's own LATEST snapshot (any computed_at — no `<= now()` bound, same as
--           before; a NULL fmv_usd on the latest row still wins the tier and falls to tier 3,
--           because the sibling arm is gated on `lf.edition_id IS NULL`, i.e. NO snapshot at
--           all, exactly as the old `sf ON ... AND lf.edition_id IS NULL`);
--   tier 2: for an integer-keyed edition (external_id ~ '^\d+:\d+$') with no snapshot, the
--           highest latest-FMV among editions sharing name+series with a different id and
--           having a snapshot (`JOIN LATERAL ... LIMIT 1` = the old inner JOIN latest_fmv;
--           `ORDER BY fmv_usd DESC NULLS LAST LIMIT 1` = the old DISTINCT ON ordering);
--   tier 3: wmc.fmv_usd; empty wallet -> 0; collection scope on the editions join kept.
--
-- VERIFIED before apply (probe copy get_wallet_total_fmv__probe, dropped):
--   * old = new on 13 live (wallet, collection) pairs incl. 3 whole-wallet (NULL) calls,
--     the Golazos collision-decoy wallet 0x4ba45c2312086820 across 3 collections, two
--     Panini (Solana-keyed) wallets, a Pinnacle slice, the 15k Top Shot wallet ($70,011.02)
--     and the All Day slice the live function could not finish ($263.41, checked against
--     the old body run as a literal query).
--   * buffers: 15k wallet 1,367,569 -> ~105k (the remaining cost is one fmv_snapshots probe
--     per MOMENT; per-edition dedupe is a further body change, known-issues #52);
--     All Day slice: 30 s timeout -> 44 ms / 8,294 buffers.
--   * a 155k-moment wallet called with p_collection_id NULL still exceeds 30 s in BOTH
--     versions (no regression, not a fix) — that call shape is not on a user path.
--
-- No live row exercises tier 2 today (every held integer-keyed edition has a snapshot);
-- the pinned SQL test's synthetic EB/EA2 fixture covers it and was run on PG 16 locally.
--
-- Pinned by supabase/tests/get_wallet_total_fmv.sql (verbatim copy re-pointed to this
-- file in __tests__/db-invariants-drift-guard.test.ts).
--
-- REVERT: re-apply the CREATE OR REPLACE from
--   supabase/migrations/20260810040000_audit_20260810_fix_get_wallet_total_fmv_collection_scope.sql
-- and re-point the PINS entry + verbatim copy back.

-- anon-exec: intentional — same signature, ACLs unchanged by CREATE OR REPLACE; the un-gated collection tab and /share/[wallet] read it anon (get_wallet_total_fmv).
-- (this marker line was added to the committed file after apply; it is a comment only, so the
-- file is no longer byte-identical to prod's recorded statements — parity is by name.)
CREATE OR REPLACE FUNCTION public.get_wallet_total_fmv(p_wallet text, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
BEGIN
  RETURN (
  SELECT COALESCE(SUM(COALESCE(lf.fmv_usd, sf.fmv_usd, wmc.fmv_usd)), 0)
  FROM wallet_moments_cache wmc
  LEFT JOIN editions e ON e.external_id = wmc.edition_key AND e.collection_id = wmc.collection_id
  LEFT JOIN LATERAL (
    SELECT fs.edition_id, fs.fmv_usd
    FROM fmv_snapshots fs
    WHERE fs.edition_id = e.id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) lf ON true
  LEFT JOIN LATERAL (
    SELECT lf2.fmv_usd
    FROM editions uuid_ed
    JOIN LATERAL (
      SELECT fs.fmv_usd
      FROM fmv_snapshots fs
      WHERE fs.edition_id = uuid_ed.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) lf2 ON true
    WHERE lf.edition_id IS NULL
      AND e.external_id ~ '^\d+:\d+$'
      AND uuid_ed.name = e.name
      AND uuid_ed.series = e.series
      AND uuid_ed.id != e.id
    ORDER BY lf2.fmv_usd DESC NULLS LAST
    LIMIT 1
  ) sf ON true
  WHERE wmc.wallet_address = p_wallet
    AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
  );
END;
$function$;
