-- DB invariant: public.candy_retire_unseen_labelless_wmc — the census RETIRE step's delete (2026-11-12).
-- It opts past rpc_delete_guard for its own transaction, so this pin is the check on WHAT it deletes:
--   1. only Candy rows, only on keys that are Candy editions STILL without a thumbnail (a key filled since the
--      caller read it is skipped — a labelled edition's holders are never deleted);
--   2. nothing at all when the rows exceed p_max_rows (refused, not truncated);
--   3. moment_id is not unique across collections — another collection's row on the same key survives.
-- The function DDL is VERBATIM from supabase/migrations/20261112183358_audit_20261112_candy_retire_unseen_labelless_wmc.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.editions (collection_id uuid, external_id text, thumbnail_url text);
CREATE TABLE public.wallet_moments_cache (id serial primary key, wallet_address text, collection_id uuid, moment_id text, edition_key text);

-- >>> BEGIN verbatim candy_retire_unseen_labelless_wmc >>>
CREATE OR REPLACE FUNCTION public.candy_retire_unseen_labelless_wmc(p_edition_keys text[], p_max_rows integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_keys text[];
  v_rows integer;
  v_wallets integer;
  v_deleted integer := 0;
BEGIN
  IF p_edition_keys IS NULL OR cardinality(p_edition_keys) = 0 THEN
    RETURN jsonb_build_object('retired', 0, 'rows', 0, 'refused', false, 'keys', 0);
  END IF;
  SELECT array_agg(e.external_id) INTO v_keys
    FROM public.editions e
   WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
     AND e.external_id = ANY (p_edition_keys)
     AND e.thumbnail_url IS NULL;
  IF v_keys IS NULL THEN
    RETURN jsonb_build_object('retired', 0, 'rows', 0, 'refused', false, 'keys', 0);
  END IF;
  SELECT count(*), count(DISTINCT wallet_address) INTO v_rows, v_wallets
    FROM public.wallet_moments_cache
   WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
     AND edition_key = ANY (v_keys);
  IF p_max_rows IS NULL OR v_rows > p_max_rows THEN
    RETURN jsonb_build_object('retired', 0, 'rows', v_rows, 'wallets', v_wallets, 'refused', true, 'keys', cardinality(v_keys));
  END IF;
  -- Scoped opt-in past rpc_delete_guard, this transaction only (set_config is_local = true).
  PERFORM set_config('rpc.allow_bulk_delete', 'on', true);
  WITH del AS (
    DELETE FROM public.wallet_moments_cache
     WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
       AND edition_key = ANY (v_keys)
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;
  PERFORM set_config('rpc.allow_bulk_delete', 'off', true);
  RETURN jsonb_build_object('retired', v_deleted, 'rows', v_rows, 'wallets', v_wallets, 'refused', false, 'keys', cardinality(v_keys));
END
$fn$;
-- <<< END verbatim candy_retire_unseen_labelless_wmc <<<

INSERT INTO public.editions VALUES
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:aq:fabricated', NULL),
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:aq:filled', 'https://arweave.net/x'),
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:big:fabricated', NULL);
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key) VALUES
  ('W1', '209ade70-32c5-4470-bc7c-4793d660f713', 'm1', 'c:aq:fabricated'),
  ('W2', '209ade70-32c5-4470-bc7c-4793d660f713', 'm2', 'c:aq:fabricated'),
  ('W3', '209ade70-32c5-4470-bc7c-4793d660f713', 'm3', 'c:aq:fabricated'),
  ('W4', '209ade70-32c5-4470-bc7c-4793d660f713', 'm4', 'c:aq:fabricated'),
  ('W5', '209ade70-32c5-4470-bc7c-4793d660f713', 'm5', 'c:aq:filled'),
  -- another collection, same key string → never touched
  ('W6', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm1', 'c:aq:fabricated'),
  ('W7', '209ade70-32c5-4470-bc7c-4793d660f713', 'b1', 'c:big:fabricated'),
  ('W8', '209ade70-32c5-4470-bc7c-4793d660f713', 'b2', 'c:big:fabricated'),
  ('W9', '209ade70-32c5-4470-bc7c-4793d660f713', 'b3', 'c:big:fabricated');

DO $$
DECLARE r jsonb; n int;
BEGIN
  -- over the cap: refused, nothing deleted
  r := public.candy_retire_unseen_labelless_wmc(ARRAY['c:big:fabricated'], 2);
  PERFORM _assert_eq(r->>'refused', 'true', 'more rows than p_max_rows is refused');
  SELECT count(*) INTO n FROM public.wallet_moments_cache WHERE edition_key = 'c:big:fabricated';
  PERFORM _assert_eq(n::text, '3', 'a refusal deletes nothing');

  -- a FILLED key passed in is skipped; the label-less key's Candy rows go; the other collection's row stays
  r := public.candy_retire_unseen_labelless_wmc(ARRAY['c:aq:fabricated', 'c:aq:filled'], 10);
  PERFORM _assert_eq(r->>'retired', '4', 'the four Candy rows on the label-less edition are retired (across 4 wallets — past the guard)');
  SELECT count(*) INTO n FROM public.wallet_moments_cache WHERE edition_key = 'c:aq:filled';
  PERFORM _assert_eq(n::text, '1', 'a labelled edition''s holder is never deleted, even when its key is passed');
  SELECT count(*) INTO n FROM public.wallet_moments_cache WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  PERFORM _assert_eq(n::text, '1', 'another collection''s row on the same key string survives');
  PERFORM _assert_eq(coalesce(current_setting('rpc.allow_bulk_delete', true), 'off'), 'off', 'the guard opt-in does not leak past the call');
END $$;

ROLLBACK;
