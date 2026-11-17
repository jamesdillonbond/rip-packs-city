-- DB invariant: public.fmv_thin_sale_ask_disclosure_refresh — one of only two
-- SCHEDULED SECDEF functions that DELETE and were unpinned (measured 2026-08-15:
-- 169 SECDEF writers, 36 on an active pg_cron schedule, 17 of those unpinned).
--
-- Deleters were pinned first, deliberately: over-deletion here produces an
-- ABSENCE, not an error, so nothing downstream reports it. The cache it rebuilds
-- feeds the thin-sale ask DISCLOSURE — the copy telling a collector that an FMV
-- is derived from an ask rather than from sales — so a silently-empty cache does
-- not break a page, it removes a caveat from a price. That is the failure mode
-- this repo keeps paying for: not a 500, a confidently wrong number.
--
-- THE THREE PROPERTIES THAT MATTER:
--
--   1. DELETE-THEN-INSERT IN ONE TRANSACTION. The table must never be observed
--      empty by a concurrent reader. Asserted by proving the post-state, and by
--      the structural check below that there is no COMMIT between the two.
--   2. IT REBUILDS FROM THE VIEW, NEVER A COPY OF THE VIEW'S PREDICATE. The
--      function's own COMMENT states this: reading a re-derived predicate would
--      let the disclosure drift from the clamp it describes, which is precisely
--      how the Pinnacle FMV drift guard degenerated into a tautology.
--   3. A ZERO-ROW RESULT IS REPORTED, NOT SILENT. `rows` comes back in the jsonb
--      so an empty rebuild is legible. An empty cohort is legitimately possible
--      (the clamp can drain it), which is exactly why it must be reported rather
--      than inferred from the table being empty.
--
-- ⚠ The body's `set_config('statement_timeout', ...)` is NOT belt-and-braces
-- decoration and must not be "simplified" away. Its comment records that the
-- first scheduled run died at exactly 120s **despite proconfig saying 300s** —
-- an independent, dated confirmation of the platform fact CLAUDE.md documents
-- twice elsewhere: a function-level `SET statement_timeout` does NOT bind
-- statements inside that function. Only the set_config() call actually applies.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260805125830_audit_20260805_thin_sale_disclosure_refresh_cron_heavy_and_timeout.sql),
-- verified byte-identical to the live prod definition via
-- md5(pg_get_functiondef(oid)) = 43300f8b9d9f2c3d51252f4bb17f8e6d on 2026-08-15.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins. The real cache carries the disclosure columns; the shape
-- only has to satisfy `INSERT ... SELECT v.*, now()`.
CREATE TABLE public.fmv_thin_sale_ask_disclosure_cache (
  edition_id   uuid,
  disclosure   text,
  refreshed_at timestamptz
);

CREATE TABLE public._src (
  edition_id uuid,
  disclosure text
);

CREATE VIEW public.v_fmv_thin_sale_ask_disclosure AS
  SELECT edition_id, disclosure FROM public._src;

-- >>> BEGIN verbatim fmv_thin_sale_ask_disclosure_refresh (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.fmv_thin_sale_ask_disclosure_refresh()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '900s'
AS $function$
DECLARE
  t0 timestamptz := clock_timestamp();
  v_rows bigint;
BEGIN
  -- Applies to this transaction regardless of the caller's configured timeout.
  -- The first scheduled run died at exactly 120s despite proconfig saying 300s.
  PERFORM set_config('statement_timeout', '900s', true);

  -- Single transaction: the table is never observed empty by a concurrent reader.
  DELETE FROM public.fmv_thin_sale_ask_disclosure_cache;

  INSERT INTO public.fmv_thin_sale_ask_disclosure_cache
  SELECT v.*, now()
  FROM public.v_fmv_thin_sale_ask_disclosure v;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- A zero-row result is REAL (the clamp could legitimately drain the cohort), but it
  -- is also what a broken upstream looks like, so it is reported rather than silent.
  RETURN jsonb_build_object(
    'rows', v_rows,
    'duration_ms', round(EXTRACT(epoch FROM clock_timestamp() - t0) * 1000),
    'refreshed_at', now()
  );
END;
$function$;
-- <<< END verbatim fmv_thin_sale_ask_disclosure_refresh <<<

\set e1 '''11111111-1111-1111-1111-111111111111'''
\set e2 '''22222222-2222-2222-2222-222222222222'''

-- ── 1. A rebuild replaces the cache with exactly the view's current contents ──
-- Stale rows that the view no longer produces must be GONE (that is the delete's
-- job), and every row the view does produce must be present.
INSERT INTO public.fmv_thin_sale_ask_disclosure_cache (edition_id, disclosure, refreshed_at)
  VALUES (:e1::uuid, 'STALE — must not survive', now() - interval '1 day');

INSERT INTO public._src (edition_id, disclosure) VALUES
  (:e1::uuid, 'ask-derived'),
  (:e2::uuid, 'ask-derived');

SELECT _assert_eq(
  (public.fmv_thin_sale_ask_disclosure_refresh() ->> 'rows'), '2',
  'refresh must report the number of rows it inserted'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_thin_sale_ask_disclosure_cache), '2',
  'the cache holds exactly the view rows after a rebuild'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_thin_sale_ask_disclosure_cache
    WHERE disclosure = 'STALE — must not survive'), '0',
  'a stale row the view no longer produces must be DELETED, not left behind'
);

-- ── 2. It reads THE VIEW, so a change upstream reaches the cache ─────────────
-- ⚠ This is the property the function COMMENT is about, and the one that keeps
-- the disclosure from drifting away from the clamp it describes. If someone
-- "optimised" the body to select from a re-derived predicate instead of the
-- view, the cache would keep answering with the old cohort and nothing would
-- fail — the same shape as the Pinnacle FMV drift guard going tautological.
DELETE FROM public._src WHERE edition_id = :e2::uuid;

SELECT _assert_eq(
  (public.fmv_thin_sale_ask_disclosure_refresh() ->> 'rows'), '1',
  'a row leaving the view must leave the cache on the next rebuild'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_thin_sale_ask_disclosure_cache
    WHERE edition_id = :e2::uuid), '0',
  'the departed edition must be gone from the cache'
);

-- ── 3. An EMPTY cohort is a real answer, reported rather than silent ─────────
-- ⚠ Both directions matter. Zero is legitimately reachable (the clamp can drain
-- the cohort), so the function must NOT error or refuse — but it must also not
-- be indistinguishable from a broken upstream, which is why `rows` is returned.
-- A caller that inferred health from "the table is non-empty" would be unable to
-- tell a drained cohort from a rebuild that never ran.
DELETE FROM public._src;

SELECT _assert_eq(
  (public.fmv_thin_sale_ask_disclosure_refresh() ->> 'rows'), '0',
  'an empty cohort reports rows=0 rather than failing'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_thin_sale_ask_disclosure_cache), '0',
  'an empty cohort empties the cache — a stale non-empty cache would be worse'
);

-- ── 4. The rebuild is ONE transaction: no COMMIT between DELETE and INSERT ───
-- ⚠ Structural, and it cannot be observed from a single-session test: the
-- property is that a CONCURRENT reader never sees the table empty mid-rebuild.
-- What is checkable here is the thing that would break it — an intervening
-- COMMIT — so that is what is asserted. A plpgsql body that committed between
-- the two statements would expose an empty cache to every reader on every tick.
SELECT _assert_eq(
  (SELECT (position('COMMIT' in upper(prosrc)) = 0)::text
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fmv_thin_sale_ask_disclosure_refresh'),
  'true',
  'the body must not COMMIT between the DELETE and the INSERT — that would expose an empty cache'
);

-- ── 5. The delete is UNSCOPED by design, and that is the whole contract ──────
-- ⚠ Deliberately asserted, because it reads like a bug. `DELETE FROM <cache>`
-- with no WHERE is correct here: this is a full-rebuild cache, not a table with
-- independent writers. Adding a predicate would leave rows the view no longer
-- produces, which is the drift this cache exists to prevent. If a future editor
-- ever adds a second writer to this table, THIS assertion is the one that has to
-- be re-thought first.
SELECT _assert_eq(
  (SELECT (prosrc ~ 'DELETE FROM public\.fmv_thin_sale_ask_disclosure_cache;')::text
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fmv_thin_sale_ask_disclosure_refresh'),
  'true',
  'the full-rebuild DELETE must stay unscoped — a predicate would strand stale rows'
);

ROLLBACK;
