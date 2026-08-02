-- Snapshot migration: public.mark_signal_wallets_fully_enriched().
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- Transitions signal-source seeded wallets to fully_enriched once their cached
-- moment count reaches the trust threshold GREATEST(50, expected*95/100). The
-- threshold decides when a wallet's holdings are considered COMPLETE enough to
-- drive signal detection; too low and partially-indexed wallets emit false
-- signals, too high and real wallets never qualify. Only signal_source-tagged,
-- not-yet-enriched wallets with a non-NULL cached count are eligible, and the
-- transition is one-way (idempotent — already-enriched wallets are skipped).
--
-- Pinned by supabase/tests/mark_signal_wallets_fully_enriched.sql.

CREATE OR REPLACE FUNCTION public.mark_signal_wallets_fully_enriched()
 RETURNS TABLE(wallet_address text, cached_moment_count integer, expected_moment_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH transitioned AS (
    UPDATE seeded_wallets
    SET fully_enriched_at = NOW()
    WHERE 'signal_source' = ANY(seeded_wallets.tags)
      AND seeded_wallets.fully_enriched_at IS NULL
      AND seeded_wallets.cached_moment_count IS NOT NULL
      AND seeded_wallets.cached_moment_count >= GREATEST(
        50,
        COALESCE(seeded_wallets.expected_moment_count, 1) * 95 / 100
      )
    RETURNING seeded_wallets.wallet_address,
              seeded_wallets.cached_moment_count,
              seeded_wallets.expected_moment_count
  )
  SELECT t.wallet_address, t.cached_moment_count, t.expected_moment_count
  FROM transitioned t;
END;
$function$;
