-- DB invariant: public.backfill_pinnacle_trade_editions — pg_cron
-- `rpc-backfill-pinnacle-trade-editions` @ `41 * * * *`.
--
-- WHY IT MATTERS. Resolving a Pin and NAMING a trade are two different steps.
-- The resolver writes `pinnacle_nft_map`; this promotes that mapping onto
-- `pinnacle_trade_events.edition_id`. Without it a trade stays unnameable even
-- after its Pin is resolved, which is indistinguishable from the resolver never
-- having run — and until 2026-08-22 no such step existed for trades at all.
--
-- ⚠ THE DANGLING-KEY GUARD IS THE POINT, and it is the half that looks
-- redundant. `pinnacle_nft_map` can hold an `edition_key` for an edition this
-- platform does not carry a row for. Writing it onto a trade would produce a
-- trade pointing at an edition that cannot be joined — worse than NULL, because
-- NULL is honestly "we cannot name it yet" while a dangling key reads as named.
-- The `EXISTS (... pinnacle_editions ...)` clause is what prevents that, and its
-- skip count is REPORTED rather than silently dropped.
--
-- ⚠ Mirrors backfill_pinnacle_sale_editions exactly. If one is changed, ask
-- whether the other needs the same change.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260822213000_pinnacle_trades_join_the_resolver_population.sql).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_trade_events (nft_id text, edition_id text);
CREATE TABLE public.pinnacle_nft_map (nft_id text, edition_key text);
CREATE TABLE public.pinnacle_editions (id text);

-- >>> BEGIN verbatim backfill_pinnacle_trade_editions (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.backfill_pinnacle_trade_editions()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated integer;
  v_skipped integer;
BEGIN
  UPDATE pinnacle_trade_events t
  SET edition_id = m.edition_key
  FROM pinnacle_nft_map m
  WHERE t.nft_id = m.nft_id
    AND t.edition_id IS NULL
    AND EXISTS (SELECT 1 FROM pinnacle_editions pe WHERE pe.id = m.edition_key);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  SELECT count(*) INTO v_skipped
  FROM pinnacle_trade_events t
  JOIN pinnacle_nft_map m ON m.nft_id = t.nft_id
  WHERE t.edition_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM pinnacle_editions pe WHERE pe.id = m.edition_key);

  RETURN jsonb_build_object(
    'updated', v_updated,
    'skipped_missing_edition', v_skipped,
    'still_null', (SELECT count(*) FROM pinnacle_trade_events WHERE edition_id IS NULL)
  );
END;
$function$;
-- <<< END verbatim backfill_pinnacle_trade_editions <<<

INSERT INTO public.pinnacle_editions (id) VALUES ('ed-real');

INSERT INTO public.pinnacle_trade_events (nft_id, edition_id) VALUES
  ('n1', NULL),        -- mapped to a real edition -> promoted
  ('n1', NULL),        -- SECOND leg of the same Pin's trade -> also promoted
  ('n2', NULL),        -- mapped to an edition we do not carry -> skipped, stays NULL
  ('n3', NULL),        -- not in the map at all -> untouched
  ('n4', 'ed-real');   -- already named -> must not be rewritten
INSERT INTO public.pinnacle_nft_map (nft_id, edition_key) VALUES
  ('n1', 'ed-real'),
  ('n2', 'ed-missing'),
  ('n4', 'ed-other');

SELECT _assert_eq(
  (public.backfill_pinnacle_trade_editions() ->> 'updated'), '2',
  'both rows of the mapped Pin are promoted; the dangling and unmapped rows are not'
);

-- ── 1. THE DANGLING-KEY GUARD ───────────────────────────────────────────────
-- ⚠ NULL is honestly "we cannot name it yet". A key pointing at an edition we do
-- not carry reads as NAMED while joining to nothing — strictly worse than NULL.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_trade_events WHERE nft_id='n2' AND edition_id IS NULL),
  '1',
  'a map entry for an edition we do not carry is NOT written onto the trade'
);

-- ⚠ And it is COUNTED, not silently dropped — a silent skip makes a permanent
-- catalogue hole indistinguishable from having nothing to do.
SELECT _assert_eq(
  (public.backfill_pinnacle_trade_editions() ->> 'skipped_missing_edition'), '1',
  'the skipped dangling row is reported'
);

-- ── 2. WHAT MUST NOT CHANGE ─────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT edition_id FROM public.pinnacle_trade_events WHERE nft_id='n4'),
  'ed-real',
  'an already-named trade is never rewritten, even when the map disagrees'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_trade_events WHERE nft_id='n3' AND edition_id IS NULL),
  '1',
  'a Pin absent from the map is left alone'
);

-- ── 3. IDEMPOTENCE ──────────────────────────────────────────────────────────
-- It runs hourly against a table the backfill lane is still filling, so a
-- re-run over unchanged rows must be a no-op rather than churn.
SELECT _assert_eq(
  (public.backfill_pinnacle_trade_editions() ->> 'updated'), '0',
  'a re-run promotes nothing — the work is already done'
);

-- ── 4. still_null IS THE HONEST REMAINDER ───────────────────────────────────
-- n2 (dangling) and n3 (unmapped) remain. Reporting 0 here would claim the lane
-- is fully named when two rows are not.
SELECT _assert_eq(
  (public.backfill_pinnacle_trade_editions() ->> 'still_null'), '2',
  'still_null counts every unnamed row, including ones this function cannot fix'
);

-- ── 5. A LATER MAP ENTRY IS PICKED UP ON A LATER RUN ────────────────────────
-- ⚠ Asserted across TWO calls on purpose. The resolver fills the map over many
-- runs, so the promotion must catch entries that did not exist when it last ran
-- — a single-call fixture cannot see that at all.
INSERT INTO public.pinnacle_editions (id) VALUES ('ed-missing');
SELECT _assert_eq(
  (public.backfill_pinnacle_trade_editions() ->> 'updated'), '1',
  'once the edition exists, the previously-skipped row is promoted on a later run'
);
SELECT _assert_eq(
  (SELECT edition_id FROM public.pinnacle_trade_events WHERE nft_id='n2'),
  'ed-missing',
  'and it lands the right key'
);

ROLLBACK;
