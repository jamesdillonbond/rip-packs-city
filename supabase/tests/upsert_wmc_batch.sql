-- DB invariant: public.upsert_wmc_batch(jsonb) → jsonb — the batch write path
-- into wallet_moments_cache, the platform's largest table (~2.2M rows) and the
-- substrate for wallet portfolios, /share, the Set Tracker and every wallet
-- rollup.
--
-- Pins the two behaviours that are easy to "simplify" away, plus the shape of
-- the returned counters:
--   • The conditional `DO UPDATE ... WHERE`: a row whose edition_key,
--     serial_number and freshness are ALL unchanged must NOT be rewritten.
--     Dropping that predicate turns every wallet re-walk into a full rewrite of
--     the wallet's rows — sustained HOT-update and index churn on a 2.2M-row
--     table, on an instance that is documented as disk-IO-bound. The guard is a
--     cost control, not a style choice, and `written` is how it is observable.
--   • The 24-hour clause still refreshes an otherwise-identical row, so
--     "unchanged" never means "never touched again" and last_seen_at cannot
--     freeze (staleness checks read it).
--   • `written` counts rows ACTUALLY written, not rows submitted — the two
--     differ precisely when the guard suppresses a no-op, which is the signal.
--   • Empty input short-circuits to {total:0, written:0} rather than erroring.
--   • A NULL last_seen_at COALESCEs to now() rather than writing NULL.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260904062632_audit_20260904_upsert_wmc_batch_keys_a_resolved_parallel_at_write_time_and_a_oneshot_rekeys_the_67k_base_keyed_rows.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE wallet_moments_cache (
  wallet_address text,
  collection_id  uuid,
  moment_id      text,
  edition_key    text,
  serial_number  integer,
  last_seen_at   timestamptz,
  PRIMARY KEY (wallet_address, collection_id, moment_id)
);

-- 2026-09-04: the function now consults the on-chain subedition map and the editions catalog
-- to key a Top Shot PARALLEL as base::N at write time (see the migration header). Minimal
-- stand-ins for both, with the columns the function reads.
CREATE TABLE topshot_moment_subeditions (
  nft_id           text PRIMARY KEY,
  base_external_id text NOT NULL,
  subedition_id    smallint
);
CREATE TABLE editions (
  collection_id uuid NOT NULL,
  external_id   text NOT NULL,
  UNIQUE (external_id, collection_id)
);

-- >>> BEGIN verbatim upsert_wmc_batch (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.upsert_wmc_batch(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_total   int;
  v_written int;
begin
  v_total := coalesce(jsonb_array_length(p_rows), 0);
  if v_total = 0 then
    return jsonb_build_object('total', 0, 'written', 0);
  end if;

  with input as (
    select
      r.wallet_address,
      r.collection_id,
      r.moment_id,
      -- Top Shot only: a base setID:playID key whose nft is on-chain-resolved to a parallel
      -- (topshot_moment_subeditions.subedition_id > 0) and whose base::N edition exists is
      -- written as base::N. Unresolved, Standard (0), or not-yet-cataloged → the key as sent.
      case
        when r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         and r.edition_key ~ '^[0-9]+:[0-9]+$'
        then coalesce(
          (select sub.base_external_id || '::' || sub.subedition_id::text
             from public.topshot_moment_subeditions sub
            where sub.nft_id = r.moment_id
              and sub.base_external_id = r.edition_key
              and coalesce(sub.subedition_id, 0) > 0
              and exists (select 1 from public.editions e
                           where e.collection_id = r.collection_id
                             and e.external_id = sub.base_external_id || '::' || sub.subedition_id::text)),
          r.edition_key)
        else r.edition_key
      end as edition_key,
      r.serial_number,
      r.last_seen_at
    from jsonb_to_recordset(p_rows) as r(
      wallet_address text,
      collection_id  uuid,
      moment_id      text,
      edition_key    text,
      serial_number  integer,
      last_seen_at   timestamptz
    )
  ),
  upserted as (
    insert into public.wallet_moments_cache as w (
      wallet_address, collection_id, moment_id,
      edition_key, serial_number, last_seen_at
    )
    select
      wallet_address, collection_id, moment_id,
      edition_key, serial_number, coalesce(last_seen_at, now())
    from input
    on conflict (wallet_address, collection_id, moment_id) do update
      set edition_key   = excluded.edition_key,
          serial_number = excluded.serial_number,
          last_seen_at  = excluded.last_seen_at
      where w.edition_key   is distinct from excluded.edition_key
         or w.serial_number is distinct from excluded.serial_number
         or w.last_seen_at  < now() - interval '24 hours'
    returning 1
  )
  select count(*)::int into v_written from upserted;

  return jsonb_build_object('total', v_total, 'written', coalesce(v_written, 0));
end;
$function$;
-- <<< END verbatim upsert_wmc_batch <<<

-- Empty input short-circuits without erroring.
SELECT _assert_eq(
  public.upsert_wmc_batch('[]'::jsonb)::text, '{"total": 0, "written": 0}',
  'empty batch returns {total:0, written:0}'
);
-- A SQL NULL argument is the case the COALESCE actually guards
-- (jsonb_array_length(NULL) → NULL → 0).
SELECT _assert_eq(
  public.upsert_wmc_batch(NULL::jsonb)::text, '{"total": 0, "written": 0}',
  'SQL NULL batch returns {total:0, written:0} — this is what the COALESCE guards'
);

-- ⚠ Documented sharp edge, pinned so nobody "fixes" the COALESCE believing it
-- covers more than it does: the guard protects against a SQL NULL ONLY.
-- jsonb_array_length RAISES on a JSON scalar or object rather than returning
-- NULL, so a caller that passes `null`/`{}` as the jsonb payload gets a hard
-- 22023 error, not a quiet {total:0}. Callers must send an ARRAY (`[]` for
-- empty). Pinned as the CURRENT contract, not endorsed as ideal — if this is
-- ever hardened to accept a non-array, this assertion is the intended place to
-- notice and update.
DO $$
BEGIN
  PERFORM public.upsert_wmc_batch('null'::jsonb);
  RAISE EXCEPTION 'expected a jsonb scalar payload to raise, but it succeeded';
EXCEPTION
  WHEN invalid_parameter_value THEN NULL; -- 22023: "cannot get array length of a scalar"
END $$;

DO $$
BEGIN
  PERFORM public.upsert_wmc_batch('{}'::jsonb);
  RAISE EXCEPTION 'expected a jsonb object payload to raise, but it succeeded';
EXCEPTION
  WHEN invalid_parameter_value THEN NULL; -- "cannot get array length of a non-array"
END $$;

-- Payloads are built with jsonb_build_* against now() rather than hardcoded ISO
-- strings. A literal timestamp makes this suite a TIME BOMB: the 24h refresh
-- clause below turns "unchanged and fresh" into "unchanged but stale" once the
-- literal ages past a day, so the no-op assertion would pass on the day it was
-- written and silently invert later.
CREATE OR REPLACE FUNCTION _row(p_moment text, p_key text, p_serial int, p_seen timestamptz)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'wallet_address', '0xaaaa000000000001',
    'collection_id',  '95f28a17-224a-4025-96ad-adf8a4c63bfd',
    'moment_id',      p_moment,
    'edition_key',    p_key,
    'serial_number',  p_serial,
    'last_seen_at',   p_seen
  )
$$;

-- First insert of two rows.
SELECT _assert_eq(
  public.upsert_wmc_batch(jsonb_build_array(
    _row('m1', '1:2', 5, now()),
    _row('m2', '3:4', 9, now())
  ))->>'written',
  '2', 'first insert writes both rows'
);
SELECT _assert_eq((SELECT count(*)::text FROM wallet_moments_cache), '2', 'two rows present');

-- THE COST-CONTROL INVARIANT: re-submitting IDENTICAL, FRESH rows writes NOTHING.
SELECT _assert_eq(
  public.upsert_wmc_batch(jsonb_build_array(_row('m1', '1:2', 5, now())))->>'written',
  '0',
  'an unchanged, fresh row is NOT rewritten (drop this guard and every wallet re-walk rewrites the table)'
);
-- ...and `total` still reports what was SUBMITTED, so the gap is observable.
SELECT _assert_eq(
  public.upsert_wmc_batch(jsonb_build_array(_row('m1', '1:2', 5, now())))->>'total',
  '1', 'total counts submitted rows, written counts actual writes'
);

-- A CHANGED edition_key does write.
SELECT _assert_eq(
  public.upsert_wmc_batch(jsonb_build_array(_row('m1', '9:9', 5, now())))->>'written',
  '1', 'a changed edition_key is written through'
);
SELECT _assert_eq(
  (SELECT edition_key FROM wallet_moments_cache WHERE moment_id='m1'), '9:9',
  'the new edition_key landed'
);

-- A CHANGED serial_number does write (serial drives FMV multipliers).
SELECT _assert_eq(
  public.upsert_wmc_batch(jsonb_build_array(_row('m1', '9:9', 77, now())))->>'written',
  '1', 'a changed serial_number is written through'
);
SELECT _assert_eq(
  (SELECT serial_number::text FROM wallet_moments_cache WHERE moment_id='m1'), '77',
  'the new serial_number landed'
);

-- THE ANTI-FREEZE INVARIANT: an identical row whose STORED stamp is older than
-- 24h IS refreshed, so last_seen_at cannot freeze on a never-changing moment.
UPDATE wallet_moments_cache
   SET last_seen_at = now() - interval '48 hours'
 WHERE moment_id = 'm2';
SELECT _assert_eq(
  public.upsert_wmc_batch($$[
    {"wallet_address":"0xaaaa000000000001","collection_id":"95f28a17-224a-4025-96ad-adf8a4c63bfd","moment_id":"m2","edition_key":"3:4","serial_number":9}
  ]$$::jsonb)->>'written',
  '1', 'an unchanged row older than 24h IS refreshed (staleness checks read last_seen_at)'
);
-- That same call omitted last_seen_at entirely, proving the COALESCE to now().
SELECT _assert(
  (SELECT last_seen_at > now() - interval '1 minute' FROM wallet_moments_cache WHERE moment_id='m2'),
  'an omitted/NULL last_seen_at COALESCEs to now(), never to NULL'
);

-- Cross-collection safety: the SAME moment_id under a DIFFERENT collection is a
-- distinct row (the 2026-05-06 uniqueness fix — a 2-part key would collide).
SELECT _assert_eq(
  public.upsert_wmc_batch(jsonb_build_array(jsonb_build_object(
    'wallet_address','0xaaaa000000000001',
    'collection_id','dee28451-5d62-409e-a1ad-a83f763ac070',
    'moment_id','m1','edition_key','7:7','serial_number',1,'last_seen_at',now()
  )))->>'written',
  '1', 'same moment_id in another collection inserts rather than colliding'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM wallet_moments_cache WHERE moment_id='m1'), '2',
  'both collections keep their own row for the same moment_id'
);

-- ── THE PARALLEL INVARIANT (2026-09-04) ──────────────────────────────────────
-- The indexer only ever sends setID:playID. A Top Shot nft the on-chain map has
-- resolved to a parallel whose base::N edition is cataloged lands as base::N —
-- and a later re-walk sending the base key again is a NO-OP, not a revert to
-- Standard. Measured before this: 67,607 rows across 285 wallets were parallels
-- keyed (and priced) as the Standard, reverted on every re-walk.
INSERT INTO topshot_moment_subeditions VALUES
  ('p-jukebox',   '238:8024', 20),   -- resolved parallel, edition cataloged
  ('p-uncat',     '238:8025', 19),   -- resolved parallel, ::19 NOT cataloged yet
  ('p-standard',  '238:8026', 0),    -- resolved Standard
  ('p-otherbase', '238:8027', 20);   -- resolved, but the row arrives under a DIFFERENT base
INSERT INTO editions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '238:8024'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '238:8024::20'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '238:8025'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '238:8026');

SELECT _assert_eq(
  public.upsert_wmc_batch(jsonb_build_array(
    _row('p-jukebox',  '238:8024', 3, now()),
    _row('p-uncat',    '238:8025', 4, now()),
    _row('p-standard', '238:8026', 5, now()),
    _row('p-otherbase','999:1',    6, now())
  ))->>'written',
  '4', 'four parallel-era rows insert'
);
SELECT _assert_eq(
  (SELECT edition_key FROM wallet_moments_cache WHERE moment_id='p-jukebox'), '238:8024::20',
  'a resolved parallel with a cataloged ::N edition is keyed base::N at write time'
);
SELECT _assert_eq(
  (SELECT edition_key FROM wallet_moments_cache WHERE moment_id='p-uncat'), '238:8025',
  'a resolved parallel whose ::N edition is not cataloged yet keeps the base key (the catalog step owns that)'
);
SELECT _assert_eq(
  (SELECT edition_key FROM wallet_moments_cache WHERE moment_id='p-standard'), '238:8026',
  'a resolved Standard (subedition 0) keeps the base key'
);
SELECT _assert_eq(
  (SELECT edition_key FROM wallet_moments_cache WHERE moment_id='p-otherbase'), '999:1',
  'the map is consulted only for the base the row actually arrived under'
);

-- THE ANTI-TREADMILL INVARIANT: the same base key re-sent for the already-split
-- row is NOT a change — nothing is written, the ::N key stays.
SELECT _assert_eq(
  public.upsert_wmc_batch(jsonb_build_array(_row('p-jukebox', '238:8024', 3, now())))->>'written',
  '0', 'a re-walk sending the base key does NOT revert a split row (this was the treadmill)'
);
SELECT _assert_eq(
  (SELECT edition_key FROM wallet_moments_cache WHERE moment_id='p-jukebox'), '238:8024::20',
  'the ::N key survives the re-walk'
);

-- Scope: another collection with the same nft id shape never touches the Top Shot map.
SELECT _assert_eq(
  public.upsert_wmc_batch(jsonb_build_array(jsonb_build_object(
    'wallet_address','0xaaaa000000000001',
    'collection_id','dee28451-5d62-409e-a1ad-a83f763ac070',
    'moment_id','p-jukebox','edition_key','238:8024','serial_number',3,'last_seen_at',now()
  )))->>'written',
  '1', 'a non-Top-Shot row inserts'
);
SELECT _assert_eq(
  (SELECT edition_key FROM wallet_moments_cache WHERE moment_id='p-jukebox' AND collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'),
  '238:8024', 'the parallel map is Top Shot-only — another collection keeps the key as sent'
);

ROLLBACK;
