-- DB invariant: public.bridge_pinnacle_sales_editions — pg_cron
-- `rpc-pinnacle-bridge-selfheal` @ `41 5 * * *`.
--
-- WHAT IT DOES. Backfills `pinnacle_sales.edition_id` from the render spine, by
-- joining `pinnacle_catalog.legacy_edition_key` to `pinnacle_editions.edition_key`.
--
-- ⚠ IT SITS DIRECTLY ON THE DEEP-AUDIT R4 SURFACE. Those are the Pinnacle sales
-- carrying a NULL `edition_id` — the ones that left the overview's top-sales
-- panel unable to NAME 2 of its top 5, and nearly had it publish "No sales in
-- the last 24h" over a 960-sale day. This function is the self-heal for exactly
-- that column, so how conservatively it fills is the whole question.
--
-- THE PROPERTIES:
--
--   1. ⚠ `HAVING count(DISTINCT pe.id) = 1` — IT BRIDGES ONLY AN UNAMBIGUOUS
--      MAPPING. A render whose legacy key resolves to MORE THAN ONE edition is
--      left NULL. This is the single most important line: attributing a sale to
--      an arbitrary one of several candidate editions would move that edition's
--      FMV, and a wrong price is worse than a missing name. Note the `min(pe.id)`
--      is only reachable when the HAVING already proved there is exactly one
--      candidate — it is a syntactic requirement of the GROUP BY, not a
--      tie-break, and reading it as a tie-break is the mistake to avoid.
--   2. FILL-ONLY. `WHERE ps.edition_id IS NULL` — an existing attribution is
--      never overwritten, so a correction made anywhere else survives this job.
--   3. Every bridged sale gets an audit row, `ON CONFLICT (sale_id) DO NOTHING`.
--   4. ⚠ THE RETURN VALUE COUNTS AUDIT INSERTS, NOT UPDATES. A sale whose audit
--      row already exists is still updated but NOT counted, so the return is a
--      lower bound on work done. Asserted, because an operator reading a 0 would
--      otherwise reasonably conclude nothing happened.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816020000_audit_20260816_snapshot_pinnacle_bridge_and_allday_badge_low_ask.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 67f72658e02dd5399049213b4282efad).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_catalog (
  render_id           text,
  legacy_edition_key  text
);

CREATE TABLE public.pinnacle_editions (
  id          text,
  edition_key text
);

CREATE TABLE public.pinnacle_sales (
  id         bigint,
  render_id  text,
  edition_id text
);

CREATE TABLE public.audit_20260716_pinnacle_render_bridge (
  sale_id        bigint PRIMARY KEY,
  render_id      text,
  new_edition_id text
);

-- >>> BEGIN verbatim bridge_pinnacle_sales_editions (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.bridge_pinnacle_sales_editions()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE v_total integer := 0;
BEGIN
  WITH map AS (
    SELECT pc.render_id, min(pe.id) AS edition_id
    FROM public.pinnacle_catalog pc
    JOIN public.pinnacle_editions pe ON pe.edition_key = pc.legacy_edition_key
    WHERE pc.legacy_edition_key IS NOT NULL
    GROUP BY pc.render_id
    HAVING count(DISTINCT pe.id) = 1
  ),
  upd AS (
    UPDATE public.pinnacle_sales ps
       SET edition_id = m.edition_id
      FROM map m
     WHERE ps.edition_id IS NULL
       AND ps.render_id = m.render_id
    RETURNING ps.id, ps.render_id, ps.edition_id
  ),
  aud AS (
    INSERT INTO public.audit_20260716_pinnacle_render_bridge (sale_id, render_id, new_edition_id)
    SELECT id, render_id, edition_id FROM upd
    ON CONFLICT (sale_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_total FROM aud;
  RETURN v_total;
END;
$function$;
-- <<< END verbatim bridge_pinnacle_sales_editions <<<

-- clean   : render maps to exactly ONE edition          -> bridged
-- ambig   : render maps to TWO editions                 -> LEFT NULL
-- nokey   : catalog row has a NULL legacy_edition_key   -> no map entry
-- nomatch : legacy key matches no pinnacle_editions row -> no map entry
INSERT INTO public.pinnacle_catalog (render_id, legacy_edition_key) VALUES
  ('R-CLEAN',   'KEY-A'),
  ('R-AMBIG',   'KEY-B'),
  ('R-NOKEY',   NULL),
  ('R-NOMATCH', 'KEY-MISSING');

INSERT INTO public.pinnacle_editions (id, edition_key) VALUES
  ('ed-1', 'KEY-A'),
  ('ed-2', 'KEY-B'),
  ('ed-3', 'KEY-B');   -- second candidate for R-AMBIG

INSERT INTO public.pinnacle_sales (id, render_id, edition_id) VALUES
  (1, 'R-CLEAN',   NULL),
  (2, 'R-AMBIG',   NULL),
  (3, 'R-NOKEY',   NULL),
  (4, 'R-NOMATCH', NULL),
  (5, 'R-CLEAN',   'ed-PRESET');  -- already attributed -> must not be touched

SELECT _assert_eq(
  public.bridge_pinnacle_sales_editions()::text, '1',
  'only the unambiguous, unattributed sale is bridged'
);

SELECT _assert_eq(
  (SELECT edition_id FROM public.pinnacle_sales WHERE id = 1), 'ed-1',
  'the clean render resolves to its single edition'
);

-- ⚠ THE MOST IMPORTANT ASSERTION IN THIS FILE. Dropping the HAVING clause would
-- silently attribute this sale to min(pe.id) = 'ed-2', moving that edition's FMV
-- on the strength of a guess. A missing name is recoverable; a wrong price is
-- published.
SELECT _assert_eq(
  (SELECT coalesce(edition_id, 'NULL') FROM public.pinnacle_sales WHERE id = 2), 'NULL',
  'an AMBIGUOUS render (2 candidate editions) is left NULL, never guessed'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_sales
    WHERE id IN (3, 4) AND edition_id IS NOT NULL),
  '0',
  'a null legacy key and an unmatched key both yield no mapping'
);

-- FILL-ONLY: a correction made elsewhere must survive this job.
SELECT _assert_eq(
  (SELECT edition_id FROM public.pinnacle_sales WHERE id = 5), 'ed-PRESET',
  'an already-attributed sale is never overwritten'
);

SELECT _assert_eq(
  (SELECT new_edition_id FROM public.audit_20260716_pinnacle_render_bridge WHERE sale_id = 1),
  'ed-1',
  'the bridge is audited so the change is reversible'
);

-- ── Idempotence, and the reporting subtlety ─────────────────────────────────
SELECT _assert_eq(
  public.bridge_pinnacle_sales_editions()::text, '0',
  'a second run bridges nothing'
);

-- ⚠ THE RETURN IS AUDIT INSERTS, NOT UPDATES. Clearing the sale's edition_id
-- while LEAVING its audit row makes the function update a row and report ZERO —
-- a real state after any manual correction, and an operator reading that 0 would
-- reasonably conclude nothing happened. Pinned so the discrepancy is a known
-- property rather than a surprise during an incident.
UPDATE public.pinnacle_sales SET edition_id = NULL WHERE id = 1;

SELECT _assert_eq(
  public.bridge_pinnacle_sales_editions()::text, '0',
  'the return counts AUDIT inserts, so a re-bridge with an existing audit row reports 0'
);

SELECT _assert_eq(
  (SELECT edition_id FROM public.pinnacle_sales WHERE id = 1), 'ed-1',
  '...even though the sale WAS re-bridged — the work happened, the count did not show it'
);

ROLLBACK;
