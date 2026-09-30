-- audit_20260929_record_link_state_script_write_keeps_event_provenance
-- anon-exec: unchanged (record_link_state) — CREATE OR REPLACE of an existing fn, identical signature and return type; ACL preserved, verified has_function_privilege anon=false, authenticated=false, service_role=true (2026-09-29).
--
-- WHAT BROKE: record_link_state treated a NULL p_event_block (a script read of
-- current chain state) as "newer than anything", so a script write on an
-- existing EVENT row replaced last_event_block and last_event_tx with NULL and
-- re-stamped last_event_at to now(). The 2026-09-29 child-side backfill did
-- this to 36 event rows (provenance lost), and the daily wallets lane
-- (job rpc-hybrid-custody-backfill-wallets) would have kept doing it. It also
-- re-stamped every script row's last_event_at on every probe; that column is
-- what resolve_canonical_owner and analytics_sales_resolved use to pick a parent
-- for a child with several (139 such children today).
--
-- THE CHANGE: last_event_at / last_event_tx / last_event_block are written only
-- by an event (non-NULL block), or when the row is first inserted. active,
-- relationship, source and link_uuid rules are unchanged. Base = 20260802000200
-- (live prosrc md5 b6af24f51389ed9b9a099201baacda59, re-read before apply).
-- Pinned: supabase/tests/record_link_state.sql (two new sections).
--
-- Revert: re-apply the CREATE OR REPLACE from 20260802000200.

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
    -- last_event fields advance monotonically by block height, and ONLY on an
    -- event: a NULL-block write (a script read of current state) never touches
    -- them, so it cannot wipe an event row's provenance or re-stamp the
    -- last_event_at that resolve_canonical_owner orders parents by (2026-09-29:
    -- the backfill NULLed block/tx on 36 event rows).
    last_event_at    = CASE
      WHEN p_event_block IS NULL
      THEN linked_accounts.last_event_at
      WHEN linked_accounts.last_event_block IS NULL
        OR p_event_block >= linked_accounts.last_event_block
      THEN EXCLUDED.last_event_at
      ELSE linked_accounts.last_event_at
    END,
    last_event_tx    = CASE
      WHEN p_event_block IS NULL
      THEN linked_accounts.last_event_tx
      WHEN linked_accounts.last_event_block IS NULL
        OR p_event_block >= linked_accounts.last_event_block
      THEN EXCLUDED.last_event_tx
      ELSE linked_accounts.last_event_tx
    END,
    last_event_block = CASE
      WHEN p_event_block IS NULL
      THEN linked_accounts.last_event_block
      WHEN linked_accounts.last_event_block IS NULL
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
