-- DB invariant: public.record_link_state(text,text,text,boolean,bigint,text,bigint,text,timestamptz)
-- — the write path for the HybridCustody account-linking graph (linked_accounts),
-- read by resolve_canonical_owner to dedupe parent+child wallets in leaderboards.
-- Pinned properties: bad relationship / source RAISE; a new active=true link
-- captures first_linked_at while active=false leaves it NULL; state advances ONLY
-- on a >= block-height event (an out-of-order lower-block replay never reverts a
-- link); first_linked_at is captured once and never overwritten; source priority
-- never downgrades (event > script > manual); link_uuid is COALESCEd, never nulled.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802000200_audit_20260802_snapshot_record_link_state.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE linked_accounts (
  parent_addr      text NOT NULL,
  child_addr       text NOT NULL,
  relationship     text NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  source           text NOT NULL DEFAULT 'event',
  link_uuid        bigint,
  first_linked_at  timestamptz,
  last_event_at    timestamptz NOT NULL DEFAULT now(),
  last_event_tx    text,
  last_event_block bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_addr, child_addr)
);

-- >>> BEGIN verbatim record_link_state (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.record_link_state(p_parent_addr text, p_child_addr text, p_relationship text, p_active boolean, p_link_uuid bigint DEFAULT NULL::bigint, p_event_tx text DEFAULT NULL::text, p_event_block bigint DEFAULT NULL::bigint, p_source text DEFAULT 'event'::text, p_event_at timestamp with time zone DEFAULT now())
 RETURNS linked_accounts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result linked_accounts;
BEGIN
  -- Validation
  IF p_relationship NOT IN ('restricted', 'owned') THEN
    RAISE EXCEPTION 'invalid relationship: %, must be restricted or owned', p_relationship;
  END IF;
  IF p_source NOT IN ('event', 'script', 'manual') THEN
    RAISE EXCEPTION 'invalid source: %, must be event, script, or manual', p_source;
  END IF;

  INSERT INTO linked_accounts (
    parent_addr, child_addr, relationship, active, source,
    link_uuid, first_linked_at, last_event_at, last_event_tx, last_event_block
  )
  VALUES (
    p_parent_addr, p_child_addr, p_relationship, p_active, p_source,
    p_link_uuid,
    CASE WHEN p_active THEN p_event_at ELSE NULL END,
    p_event_at,
    p_event_tx,
    p_event_block
  )
  ON CONFLICT (parent_addr, child_addr) DO UPDATE
  SET
    -- Only advance state if this event is newer than what we have
    active           = CASE
      WHEN linked_accounts.last_event_block IS NULL
        OR p_event_block IS NULL
        OR p_event_block >= linked_accounts.last_event_block
      THEN EXCLUDED.active
      ELSE linked_accounts.active
    END,
    relationship     = CASE
      WHEN linked_accounts.last_event_block IS NULL
        OR p_event_block IS NULL
        OR p_event_block >= linked_accounts.last_event_block
      THEN EXCLUDED.relationship
      ELSE linked_accounts.relationship
    END,
    link_uuid        = COALESCE(EXCLUDED.link_uuid, linked_accounts.link_uuid),
    -- first_linked_at is captured on the first observed active=true event and never overwritten
    first_linked_at  = COALESCE(linked_accounts.first_linked_at, EXCLUDED.first_linked_at),
    -- last_event fields advance monotonically by block height
    last_event_at    = CASE
      WHEN linked_accounts.last_event_block IS NULL
        OR p_event_block IS NULL
        OR p_event_block >= linked_accounts.last_event_block
      THEN EXCLUDED.last_event_at
      ELSE linked_accounts.last_event_at
    END,
    last_event_tx    = CASE
      WHEN linked_accounts.last_event_block IS NULL
        OR p_event_block IS NULL
        OR p_event_block >= linked_accounts.last_event_block
      THEN EXCLUDED.last_event_tx
      ELSE linked_accounts.last_event_tx
    END,
    last_event_block = CASE
      WHEN linked_accounts.last_event_block IS NULL
        OR p_event_block IS NULL
        OR p_event_block >= linked_accounts.last_event_block
      THEN EXCLUDED.last_event_block
      ELSE linked_accounts.last_event_block
    END,
    -- source priority: event > script > manual; never downgrade
    source           = CASE
      WHEN linked_accounts.source = 'event' THEN linked_accounts.source
      WHEN linked_accounts.source = 'script' AND EXCLUDED.source = 'event' THEN EXCLUDED.source
      WHEN EXCLUDED.source = 'event' THEN EXCLUDED.source
      ELSE linked_accounts.source
    END
  RETURNING * INTO result;

  RETURN result;
END;
$function$;
-- <<< END verbatim record_link_state <<<

-- ── validation: bad relationship / source RAISE ─────────────────────────────
DO $$
BEGIN
  PERFORM record_link_state('0xP','0xC','bogus',true);
  PERFORM _assert(false, 'invalid relationship should have raised');
EXCEPTION WHEN others THEN
  PERFORM _assert(SQLERRM LIKE 'invalid relationship%', 'raises on bad relationship: '||SQLERRM);
END $$;
DO $$
BEGIN
  PERFORM record_link_state('0xP','0xC','owned',true,NULL,NULL,NULL,'nope');
  PERFORM _assert(false, 'invalid source should have raised');
EXCEPTION WHEN others THEN
  PERFORM _assert(SQLERRM LIKE 'invalid source%', 'raises on bad source: '||SQLERRM);
END $$;

-- ── new active=true link captures first_linked_at ───────────────────────────
SELECT record_link_state('0xAA','0xaa','owned',true, 111, 'tx1', 100, 'event', '2026-01-01T00:00:00Z');
SELECT _assert_eq((SELECT active::text FROM linked_accounts WHERE parent_addr='0xAA'), 'true', 'new link active');
SELECT _assert_eq((SELECT (first_linked_at IS NOT NULL)::text FROM linked_accounts WHERE parent_addr='0xAA'),
  'true', 'active=true captures first_linked_at');
SELECT _assert_eq((SELECT last_event_block::text FROM linked_accounts WHERE parent_addr='0xAA'), '100', 'block recorded');
SELECT _assert_eq((SELECT link_uuid::text FROM linked_accounts WHERE parent_addr='0xAA'), '111', 'link_uuid recorded');

-- ── new active=false link leaves first_linked_at NULL ───────────────────────
SELECT record_link_state('0xBB','0xbb','owned',false, NULL, 'txb', 100, 'event', '2026-01-01T00:00:00Z');
SELECT _assert_eq((SELECT first_linked_at IS NULL FROM linked_accounts WHERE parent_addr='0xBB')::text,
  'true', 'active=false leaves first_linked_at NULL');

-- ── stale (lower-block) event does NOT revert state (monotonic guard) ────────
SELECT record_link_state('0xAA','0xaa','restricted',false, NULL, 'tx_stale', 50, 'event', '2026-01-02T00:00:00Z');
SELECT _assert_eq((SELECT active::text FROM linked_accounts WHERE parent_addr='0xAA'), 'true',
  'stale block-50 event does not deactivate a block-100 link');
SELECT _assert_eq((SELECT relationship FROM linked_accounts WHERE parent_addr='0xAA'), 'owned',
  'stale event does not change relationship');
SELECT _assert_eq((SELECT last_event_block::text FROM linked_accounts WHERE parent_addr='0xAA'), '100',
  'stale event does not advance last_event_block');

-- ── newer (higher-block) event DOES advance state ───────────────────────────
SELECT record_link_state('0xAA','0xaa','restricted',false, NULL, 'tx_new', 200, 'event', '2026-01-03T00:00:00Z');
SELECT _assert_eq((SELECT active::text FROM linked_accounts WHERE parent_addr='0xAA'), 'false',
  'newer block-200 event deactivates');
SELECT _assert_eq((SELECT relationship FROM linked_accounts WHERE parent_addr='0xAA'), 'restricted',
  'newer event advances relationship');
SELECT _assert_eq((SELECT last_event_block::text FROM linked_accounts WHERE parent_addr='0xAA'), '200',
  'newer event advances last_event_block');
-- first_linked_at survives the newer event unchanged (captured once, never overwritten)
SELECT _assert_eq((SELECT to_char(first_linked_at AT TIME ZONE 'UTC','YYYY-MM-DD') FROM linked_accounts WHERE parent_addr='0xAA'),
  '2026-01-01', 'first_linked_at is never overwritten by a later event');

-- ── link_uuid COALESCEd, never nulled by a later NULL ───────────────────────
SELECT record_link_state('0xAA','0xaa','restricted',false, NULL, 'tx_uuid', 300, 'event', '2026-01-04T00:00:00Z');
SELECT _assert_eq((SELECT link_uuid::text FROM linked_accounts WHERE parent_addr='0xAA'), '111',
  'a later NULL link_uuid does not clear the recorded one');

-- ── source priority: script → event upgrades, event → manual never downgrades ─
SELECT record_link_state('0xCC','0xcc','owned',true, NULL, 'txc', 100, 'script', '2026-01-01T00:00:00Z');
SELECT _assert_eq((SELECT source FROM linked_accounts WHERE parent_addr='0xCC'), 'script', 'seeded as script');
SELECT record_link_state('0xCC','0xcc','owned',true, NULL, 'txc2', 200, 'event', '2026-01-02T00:00:00Z');
SELECT _assert_eq((SELECT source FROM linked_accounts WHERE parent_addr='0xCC'), 'event', 'script upgrades to event');
SELECT record_link_state('0xCC','0xcc','owned',true, NULL, 'txc3', 300, 'manual', '2026-01-03T00:00:00Z');
SELECT _assert_eq((SELECT source FROM linked_accounts WHERE parent_addr='0xCC'), 'event',
  'event is never downgraded to manual');

SELECT '✓ record_link_state invariants pass' AS result;
ROLLBACK;
