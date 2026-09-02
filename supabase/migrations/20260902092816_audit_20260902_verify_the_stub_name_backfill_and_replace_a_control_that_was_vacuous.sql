-- Verification of 20260902092542 (Top Shot stub player names from wmc), and a
-- CORRECTION to that migration's post-state.
--
-- 🚨 THE CORRECTION FIRST, because a vacuous assertion reads as coverage.
-- 20260902092542's last post-state block was:
--
--   SELECT count(*) INTO v_control FROM editions e
--    WHERE e.collection_id = '<topshot>'
--      AND e.player_name IS NOT NULL AND e.player_name <> ''
--      AND (e.player_name IS NULL OR e.player_name = '');
--   IF v_control <> 0 THEN RAISE EXCEPTION ...
--
-- The predicate is `X IS NOT NULL AND (X IS NULL OR ...)` — a CONTRADICTION. It counts
-- zero for every database in every state, so it could never have failed and proved
-- nothing. It was written as a "positive control the change cannot move" and is instead
-- exactly the shape this repo's own rule warns about: a test whose TITLE carries a claim
-- its assertion does not keep. It is left in that file rather than edited, because an
-- applied migration is history; this one supersedes it.
--
-- ── THE REAL POST-CONDITION ──────────────────────────────────────────────────
-- Checked against what was ACTUALLY WRITTEN, recorded row-by-row in
-- public.audit_20260902_stub_names_written before the run, rather than re-deriving the
-- function's own predicate (which could only ever agree with itself):
--   267 written - 267 match the pre-recorded candidate - 0 carry a name wmc does not
--   hold for that edition_key - 0 sit on an edition_key wmc is ambiguous about -
--   0 left empty.
-- `get_topshot_stub_targets` fell 520 -> 253 and Top Shot's nameless editions
-- 2,000 -> 1,733, as predicted.
--
-- ⚠ NOT a claim that the 253 remainder is unresolvable: 169 have no wmc row at all and
-- 79 are genuinely multi-player plays. Neither is reachable from wmc, and neither is
-- reachable from the chain either — the resolver has said so 74,800 times.

DO $mig$
DECLARE
  v_written int; v_mismatch int; v_not_in_wmc int; v_ambiguous int; v_still_empty int;
BEGIN
  IF to_regclass('public.audit_20260902_stub_names_written') IS NULL THEN
    RAISE EXCEPTION 'post-state: the written-rows audit table is missing, so the run cannot be verified';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE e.player_name IS DISTINCT FROM a.player_name_written),
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM wallet_moments_cache w
           WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
             AND w.edition_key = a.external_id AND w.player_name = e.player_name)),
         count(*) FILTER (WHERE (
           SELECT count(DISTINCT w.player_name) FROM wallet_moments_cache w
           WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
             AND w.edition_key = a.external_id
             AND w.player_name IS NOT NULL AND w.player_name <> '') <> 1),
         count(*) FILTER (WHERE e.player_name IS NULL OR e.player_name = '')
    INTO v_written, v_mismatch, v_not_in_wmc, v_ambiguous, v_still_empty
  FROM public.audit_20260902_stub_names_written a
  JOIN editions e ON e.id = a.edition_id;

  IF v_written = 0 THEN
    RAISE EXCEPTION 'post-state: nothing recorded as written — the verification would be vacuous';
  END IF;
  IF v_mismatch <> 0 THEN
    RAISE EXCEPTION 'post-state: % edition(s) do not carry the name recorded for them', v_mismatch;
  END IF;
  IF v_not_in_wmc <> 0 THEN
    RAISE EXCEPTION 'post-state: % edition(s) carry a name wallet_moments_cache does not hold', v_not_in_wmc;
  END IF;
  IF v_ambiguous <> 0 THEN
    RAISE EXCEPTION 'post-state: % edition(s) were written from an AMBIGUOUS edition_key', v_ambiguous;
  END IF;
  IF v_still_empty <> 0 THEN
    RAISE EXCEPTION 'post-state: % edition(s) are still nameless', v_still_empty;
  END IF;

  RAISE NOTICE 'verified % written stub names', v_written;
END
$mig$;

COMMENT ON TABLE public.audit_20260902_stub_names_written IS
  'REVERT PATH for 20260902092542: the 267 Top Shot editions whose player_name was '
  'filled from wallet_moments_cache on 2026-09-02, with the value written. To undo: '
  'UPDATE editions e SET player_name = NULL FROM audit_20260902_stub_names_written a '
  'WHERE e.id = a.edition_id AND e.player_name = a.player_name_written; — all 267 were '
  'NULL or empty beforehand.';
