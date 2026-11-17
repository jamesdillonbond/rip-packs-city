-- Snapshot migration: commit the VERBATIM live body of public.record_link_state
-- so the DB-invariant test (supabase/tests/record_link_state.sql) has a committed
-- source the drift guard can compare against. Applied via the Supabase MCP with no
-- prior committed migration → previously UNPINNABLE; this byte-identical snapshot
-- is the documented remedy (see CLAUDE.md "Testing & CI coverage").
--
-- record_link_state is the write path for the HybridCustody account-linking graph
-- (linked_accounts), which resolve_canonical_owner reads to dedupe parent+child
-- wallets in every leaderboard / holdings rollup. Its correctness rests on three
-- non-obvious guards: state advances ONLY on a newer (>= block-height) event so an
-- out-of-order replay can't revert a link; first_linked_at is captured once and
-- never overwritten; and source priority never downgrades (event > script > manual).
-- Re-applying this is a no-op (CREATE OR REPLACE with the live source).

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
