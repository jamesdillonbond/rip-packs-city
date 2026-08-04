-- unmapped_sales.onchain_attempts — the counter the resolution-backlog trust arm
-- needs, and the stamping function that maintains it.
--
-- WHY (handoff 2026-08-04 §3b): the `unmapped_resolution_backlog_max` arm reads
-- BREACH at 105/100. Its recorded `catches` text prescribes the fix as "make the
-- resolver record a permanent-failure reason and exclude by REASON".
--
-- ⚠ THAT PRESCRIPTION IS WRONG AND MUST NOT BE IMPLEMENTED. It rests on the
-- premise that AllDay's `onchain_dapper_v1` cohort is permanently unresolvable.
-- Measured live 2026-08-04: v1_dapper resolved 6,943 rows in 7 days, 721 in the
-- last 24h, most recently at 16:20Z — minutes before the measurement. Excluding
-- it by reason would permanently blind the arm to real AllDay resolver stalls,
-- which is the one thing this arm exists to catch.
--
-- The backlog is not a permanent-failure class; it is RETRY-QUEUE DEPTH. The
-- resolver cycles the whole priced backlog in 7-8 days (attempt recency: <6h 309,
-- 1-3d 6,575, 3-7d 21,150, oldest 7.5d — nothing starved). The honest signal is
-- therefore "attempted N times and STILL failing", and that is inexpressible
-- today: `last_onchain_attempt_at` is a single overwritten timestamp that cannot
-- distinguish a first attempt from a twentieth.
--
-- This migration adds the missing counter. It is DELIBERATELY INERT: nothing
-- reads `onchain_attempts` yet. Retargeting the trust arm onto `>= 3` is a
-- SEPARATE change that clears a standing breach, so it is Trevor's call — and it
-- should only be made once this column has accumulated a few days of real data
-- to set the threshold from evidence rather than guesswork.
--
-- ADD COLUMN with a constant DEFAULT is metadata-only on PG11+ (no table
-- rewrite), so this is safe on the 112,762-row / 135 MB table.
--
-- Revert: DROP FUNCTION public.stamp_unmapped_onchain_attempt(uuid, text[], timestamptz);
--         ALTER TABLE public.unmapped_sales DROP COLUMN onchain_attempts;

ALTER TABLE public.unmapped_sales
  ADD COLUMN IF NOT EXISTS onchain_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.unmapped_sales.onchain_attempts IS
  'How many times an on-chain resolution attempt has been spent on this row. '
  'Companion to last_onchain_attempt_at (which is overwritten and so cannot '
  'express "tried N times and still failing"). Incremented by '
  'stamp_unmapped_onchain_attempt(). Intended consumer: the '
  'unmapped_resolution_backlog_max trust arm, so it can count rows that are '
  'genuinely stuck rather than rows that are merely queued. Never reset on '
  'resolution — a resolved row keeps its attempt history.';

-- Stamp the rotating window AND increment the attempt counter in one statement.
-- PostgREST cannot express a column-referencing update (`col = col + 1`), which
-- is why the two resolvers previously did a plain `.update({last_onchain_attempt_at})`
-- and why the counter needs a function at all.
--
-- Keyed by nft_id, NOT row id, preserving the existing stamping semantics
-- exactly: one moment can carry several unmapped sale rows and a single borrow
-- attempt covers all of them, so stamping only the deduped row would leave its
-- siblings NULL and re-select the same moment forever.
CREATE OR REPLACE FUNCTION public.stamp_unmapped_onchain_attempt(
  p_collection_id uuid,
  p_nft_ids text[],
  p_at timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF p_collection_id IS NULL OR p_nft_ids IS NULL OR array_length(p_nft_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE unmapped_sales
     SET last_onchain_attempt_at = COALESCE(p_at, now()),
         onchain_attempts = onchain_attempts + 1
   WHERE collection_id = p_collection_id
     AND resolved_at IS NULL
     AND nft_id = ANY(p_nft_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- ⚠ BOTH revokes are required, and each covers a grant the other cannot.
--
-- CLAUDE.md documents one half: a new function's default EXECUTE grant is to
-- PUBLIC, so `REVOKE ... FROM anon` alone leaves has_function_privilege('anon')
-- TRUE via the surviving PUBLIC grant.
--
-- This function hit the MIRROR case, which was not documented. Supabase's
-- ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions to anon and
-- authenticated EXPLICITLY at creation time — those are their own grant rows,
-- not the PUBLIC one — so `REVOKE ... FROM PUBLIC` alone ALSO leaves
-- has_function_privilege('anon') TRUE. Measured here: after the PUBLIC revoke
-- this write path was still anon-executable.
--
-- So: revoke from PUBLIC *and* from anon, authenticated, then re-grant only the
-- service role that actually calls it (this path is reached solely by
-- supabaseAdmin). Verify with has_function_privilege for every role — never by
-- reading the ACL text, and never with `count(*)` on the jsonb-returning drift
-- checks (that count is always 1 regardless of contents; use jsonb_array_length).
REVOKE EXECUTE ON FUNCTION public.stamp_unmapped_onchain_attempt(uuid, text[], timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stamp_unmapped_onchain_attempt(uuid, text[], timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stamp_unmapped_onchain_attempt(uuid, text[], timestamptz) TO service_role;
