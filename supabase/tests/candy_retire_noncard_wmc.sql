-- DB invariant: public.candy_retire_noncard_wmc — the census deleting holdings rows for assets it SAW as packs
-- or burnt (2026-11-12). It opts past rpc_delete_guard, so this pin is the check on WHAT it deletes:
--   1. only Candy rows (moment_id is not unique across collections — another collection's row survives);
--   2. only the moment ids passed; 3. the guard opt-in does not outlive the call.
-- The function DDL is VERBATIM from supabase/migrations/20261113032216_audit_20261112_candy_retire_noncard_wmc.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.wallet_moments_cache (id serial primary key, wallet_address text, collection_id uuid, moment_id text, edition_key text);

-- >>> BEGIN verbatim candy_retire_noncard_wmc >>>
CREATE OR REPLACE FUNCTION public.candy_retire_noncard_wmc(p_moment_ids text[])
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_deleted integer := 0;
BEGIN
  IF p_moment_ids IS NULL OR cardinality(p_moment_ids) = 0 THEN
    RETURN 0;
  END IF;
  -- Scoped opt-in past rpc_delete_guard, this transaction only.
  PERFORM set_config('rpc.allow_bulk_delete', 'on', true);
  WITH del AS (
    DELETE FROM public.wallet_moments_cache
     WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
       AND moment_id = ANY (p_moment_ids)
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;
  PERFORM set_config('rpc.allow_bulk_delete', 'off', true);
  RETURN v_deleted;
END
$fn$;
-- <<< END verbatim candy_retire_noncard_wmc <<<

INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key) VALUES
  ('W1', '209ade70-32c5-4470-bc7c-4793d660f713', 'pack1', 'c:od:reward-pack'),
  ('W2', '209ade70-32c5-4470-bc7c-4793d660f713', 'pack2', 'c:od:reward-pack'),
  ('W3', '209ade70-32c5-4470-bc7c-4793d660f713', 'pack3', 'c:od:reward-pack'),
  ('W4', '209ade70-32c5-4470-bc7c-4793d660f713', 'pack4', 'c:od:reward-pack'),
  ('W5', '209ade70-32c5-4470-bc7c-4793d660f713', 'card1', 'c:od:real'),
  ('W6', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'pack1', '1:2');

DO $$
DECLARE n int;
BEGIN
  n := public.candy_retire_noncard_wmc(ARRAY['pack1', 'pack2', 'pack3', 'pack4']);
  PERFORM _assert_eq(n::text, '4', 'the four Candy rows for the passed moment ids are deleted (across 4 wallets)');
  SELECT count(*) INTO n FROM public.wallet_moments_cache WHERE moment_id = 'card1';
  PERFORM _assert_eq(n::text, '1', 'a moment id NOT passed is untouched');
  SELECT count(*) INTO n FROM public.wallet_moments_cache WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  PERFORM _assert_eq(n::text, '1', 'another collection''s row with the same moment id survives');
  PERFORM _assert_eq(public.candy_retire_noncard_wmc(ARRAY[]::text[])::text, '0', 'an empty list deletes nothing');
  PERFORM _assert_eq(coalesce(current_setting('rpc.allow_bulk_delete', true), 'off'), 'off', 'the guard opt-in does not leak past the call');
END $$;

ROLLBACK;
