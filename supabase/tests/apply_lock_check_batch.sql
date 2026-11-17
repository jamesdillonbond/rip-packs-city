-- DB invariant: public.apply_lock_check_batch(jsonb) — the wmc lock-check writer shared by the
-- lock-check cron and the trade-room picker heal (#222). Pinned properties:
--   · a boolean result writes is_locked and stamps lock_checked_at;
--   · a NULL result (the chain returned no entry: the moment is not held) KEEPS the existing
--     flag — never "checked: unlocked" for a moment the wallet does not hold — and still stamps
--     the row, so the stalest-first rotation (get_lock_check_batch) advances past it;
--   · the write is scoped by (wallet, collection, moment): the same moment_id in another
--     collection or another wallet is untouched (a moment_id is unique only within a collection);
--   · it reports submitted / updated counts.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261101151627_audit_20261101_apply_lock_check_batch_null_keeps_flag.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE wallet_moments_cache (
  wallet_address  text,
  collection_id   uuid,
  moment_id       text,
  is_locked       boolean,
  lock_checked_at timestamptz,
  UNIQUE (wallet_address, collection_id, moment_id)
);

-- >>> BEGIN verbatim apply_lock_check_batch (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.apply_lock_check_batch(p_results jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_updated int := 0;
  v_total int;
BEGIN
  v_total := jsonb_array_length(p_results);

  WITH inputs AS (
    SELECT
      (item->>'wallet_address')::text AS wallet_address,
      (item->>'moment_id')::text AS moment_id,
      (item->>'collection_id')::uuid AS collection_id,
      (item->>'is_locked')::boolean AS is_locked
    FROM jsonb_array_elements(p_results) AS item
  ),
  claimed AS (
    SELECT wmc.wallet_address, wmc.collection_id, wmc.moment_id, i.is_locked
    FROM inputs i
    JOIN wallet_moments_cache wmc
      ON wmc.wallet_address = i.wallet_address
     AND wmc.moment_id = i.moment_id
     AND wmc.collection_id = i.collection_id
    ORDER BY wmc.wallet_address, wmc.collection_id, wmc.moment_id
    FOR UPDATE OF wmc SKIP LOCKED
  ),
  upd AS (
    UPDATE wallet_moments_cache wmc
    SET
      is_locked = COALESCE(c.is_locked, wmc.is_locked),
      lock_checked_at = NOW()
    FROM claimed c
    WHERE wmc.wallet_address = c.wallet_address
      AND wmc.moment_id = c.moment_id
      AND wmc.collection_id = c.collection_id
    RETURNING wmc.moment_id
  )
  SELECT COUNT(*) INTO v_updated FROM upd;

  RETURN json_build_object(
    'submitted', v_total,
    'updated', v_updated,
    'skipped_locked', GREATEST(v_total - v_updated, 0)
  );
END;
$function$;
-- <<< END verbatim apply_lock_check_batch <<<

INSERT INTO wallet_moments_cache VALUES
  ('0xabc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm_lock',     false, NULL),
  ('0xabc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm_unlock',   true,  NULL),
  ('0xabc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm_gone_t',   true,  now() - interval '10 days'),
  ('0xabc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm_gone_f',   false, now() - interval '10 days'),
  ('0xabc', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'm_lock',     false, NULL),
  ('0xzzz', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm_lock',     false, NULL);

SELECT _assert_eq(
  (apply_lock_check_batch('[
     {"wallet_address":"0xabc","collection_id":"95f28a17-224a-4025-96ad-adf8a4c63bfd","moment_id":"m_lock","is_locked":true},
     {"wallet_address":"0xabc","collection_id":"95f28a17-224a-4025-96ad-adf8a4c63bfd","moment_id":"m_unlock","is_locked":false},
     {"wallet_address":"0xabc","collection_id":"95f28a17-224a-4025-96ad-adf8a4c63bfd","moment_id":"m_gone_t","is_locked":null},
     {"wallet_address":"0xabc","collection_id":"95f28a17-224a-4025-96ad-adf8a4c63bfd","moment_id":"m_gone_f"}
   ]'::jsonb)->>'updated'),
  '4', 'all four rows updated (a NULL result still stamps)');

-- ── a boolean result writes the flag and stamps ──────────────────────────────
SELECT _assert_eq((SELECT is_locked::text FROM wallet_moments_cache WHERE wallet_address='0xabc' AND collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND moment_id='m_lock'),
  'true', 'a locked reading writes is_locked=true');
SELECT _assert_eq((SELECT is_locked::text FROM wallet_moments_cache WHERE wallet_address='0xabc' AND collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND moment_id='m_unlock'),
  'false', 'an unlocked reading writes is_locked=false');
SELECT _assert_eq((SELECT (lock_checked_at IS NOT NULL)::text FROM wallet_moments_cache WHERE wallet_address='0xabc' AND collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND moment_id='m_lock'),
  'true', 'a reading stamps lock_checked_at');

-- ── a NULL result keeps the flag (never fabricates "unlocked") and stamps ────
SELECT _assert_eq((SELECT is_locked::text FROM wallet_moments_cache WHERE wallet_address='0xabc' AND collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND moment_id='m_gone_t'),
  'true', 'an explicit null result does NOT flip a locked row to unlocked');
SELECT _assert_eq((SELECT is_locked::text FROM wallet_moments_cache WHERE wallet_address='0xabc' AND collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND moment_id='m_gone_f'),
  'false', 'an absent is_locked key keeps the existing flag too');
SELECT _assert_eq((SELECT (lock_checked_at > now() - interval '1 minute')::text FROM wallet_moments_cache WHERE wallet_address='0xabc' AND collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND moment_id='m_gone_t'),
  'true', 'a null result still stamps, so the stalest-first rotation moves past the row');

-- ── scoped by (wallet, collection, moment) ───────────────────────────────────
SELECT _assert_eq((SELECT is_locked::text || '/' || (lock_checked_at IS NULL)::text FROM wallet_moments_cache WHERE wallet_address='0xabc' AND collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND moment_id='m_lock'),
  'false/true', 'the same moment_id in ANOTHER collection is untouched');
SELECT _assert_eq((SELECT is_locked::text || '/' || (lock_checked_at IS NULL)::text FROM wallet_moments_cache WHERE wallet_address='0xzzz' AND moment_id='m_lock'),
  'false/true', 'the same moment in ANOTHER wallet is untouched');

-- ── a row the batch names but wmc does not hold is not counted ───────────────
SELECT _assert_eq(
  (apply_lock_check_batch('[{"wallet_address":"0xabc","collection_id":"95f28a17-224a-4025-96ad-adf8a4c63bfd","moment_id":"m_nobody","is_locked":true}]'::jsonb)->>'updated'),
  '0', 'a moment with no wmc row updates nothing');

SELECT '✓ apply_lock_check_batch invariants pass' AS result;
ROLLBACK;
