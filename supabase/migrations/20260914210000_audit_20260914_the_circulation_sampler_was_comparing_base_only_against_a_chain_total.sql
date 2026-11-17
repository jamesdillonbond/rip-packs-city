-- ─────────────────────────────────────────────────────────────────────────────
-- ⛔ I FILED #120 ON A MISDIAGNOSIS AND SHIPPED AN INSTRUMENT THAT INHERITED IT.
-- Both are corrected here, ~40 minutes later.
--
-- THE CLAIM: `editions.circulation_count` is stale-LOW, one-sided, clustering by
-- set with a constant offset (set 218 exactly 99 low, set 259 exactly 190 low).
--
-- ⭐ THE OFFSETS WERE THE PARALLELS. `TopShot.getNumMomentsInEdition(setID, playID)`
-- counts EVERY moment minted for that (set, play) — the base edition AND its
-- parallel sub-editions. `editions.circulation_count` on a BASE row counts the
-- base ONLY. Comparing them is comparing a total against a part.
--
-- MEASURED, 11 editions, and it is not a near-miss:
--   base + parallel_sum = chain   on 9 of 11
--     218:8788  4,000 +  99 = 4,099 ✓      259:8950  47 + 190 = 237 ✓
--     259:8951     95 + 190 =   285 ✓      264:8850 129 +  35 = 164 ✓
--   ...and the five where the BASE alone matched (2:62, 2:41, 2:113, 2:63, 8:62)
--   all have ZERO parallels — they matched because there was nothing to add.
-- ⭐ Every disagreement that prompted #120 is in that list. **Nothing is stale.**
-- ⚠ "One-sided and constant per set" is exactly what a PARALLEL STRUCTURE looks
-- like. I read a definitional difference as a data defect because the shape was
-- suggestive and I did not ask what the chain function actually counts.
--
-- ── WHAT THIS CHANGES IN THE INSTRUMENT ──────────────────────────────────────
-- As shipped, the sampler compared BASE-only circulation against the chain TOTAL,
-- so it would have reported `db_low` on **every edition that has a parallel** —
-- a false-positive generator dressed as an accuracy metric, on a 50-a-day
-- schedule. `db_circulation_with_parallels` is added and `agrees` now keys on it.
-- `db_circulation` is KEPT so the two definitions stay visible side by side;
-- collapsing them is how this confusion happened in the first place.
--
-- ⭐ AND THE INSTRUMENT IS STILL WORTH HAVING, for a sharper reason than before:
-- two editions do NOT sum — `51:1885` (base 4,000 + parallel 472, chain **4,000**)
-- and `218:8061` (base 4,000 + parallels 384, chain **4,099**, i.e. it counts the
-- 99-moment `::16` but not the 285-moment `::1`). So some `::N` rows are separate
-- mints under the same (set, play) and some are not, and **nothing in this estate
-- knew which**. That is now a measurable property rather than a guess.
--
-- ⚠ THE FOUR AUDIT ROWS ALREADY WRITTEN are left in place: all four are editions
-- with zero parallels, so base == base+parallels and their verdicts are unchanged
-- under the new definition. Verified in the DO block below rather than assumed.
--
-- REVERT: re-apply 20260914200000's collect function and
--   ALTER TABLE public.topshot_circulation_chain_audit DROP COLUMN db_circulation_with_parallels;
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.topshot_circulation_chain_audit
  ADD COLUMN IF NOT EXISTS db_circulation_with_parallels integer;

COMMENT ON COLUMN public.topshot_circulation_chain_audit.db_circulation IS
  'BASE edition circulation only (editions.circulation_count on the base row). Kept beside '
  'db_circulation_with_parallels on purpose: the chain function counts the TOTAL for a (set, play), '
  'and collapsing the two definitions into one column is what produced the #120 misdiagnosis.';

COMMENT ON COLUMN public.topshot_circulation_chain_audit.db_circulation_with_parallels IS
  'Base circulation PLUS the sum of its ::N parallel sub-editions — the quantity that is actually '
  'comparable to TopShot.getNumMomentsInEdition(setID, playID). `agrees` keys on THIS column.';

-- Backfill the column for the rows already written (all zero-parallel editions,
-- so this is a no-op in value and a fix in shape).
UPDATE public.topshot_circulation_chain_audit a
   SET db_circulation_with_parallels = a.db_circulation + COALESCE((
         SELECT sum(e2.circulation_count) FROM public.editions e2
          WHERE e2.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
            AND e2.external_id LIKE a.edition_external_id || '::%'), 0)
 WHERE a.db_circulation_with_parallels IS NULL;

CREATE OR REPLACE FUNCTION public.collect_topshot_circulation_sample()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
DECLARE
  v_rows int := 0;
BEGIN
  WITH resolved AS (
    SELECT p.request_id, p.edition_external_id, p.db_circulation, p.dispatched_at,
           r.status_code,
           -- ⭐ The comparable quantity: base + parallels. The chain counts the
           -- TOTAL minted for a (set, play); the base row counts the base.
           p.db_circulation + COALESCE((
             SELECT sum(e2.circulation_count) FROM public.editions e2
              WHERE e2.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
                AND e2.external_id LIKE p.edition_external_id || '::%'), 0) AS db_total,
           CASE WHEN r.status_code = 200 THEN
             (SELECT (kv->'value'->>'value')
                FROM jsonb_array_elements(
                       (convert_from(decode(trim(both '"' from r.content), 'base64'), 'UTF8')::jsonb)->'value'
                     ) kv
               WHERE kv->'key'->>'value' = '__Circulation'
               LIMIT 1)
           END AS chain_txt
      FROM public.topshot_circulation_chain_pending p
      LEFT JOIN net._http_response r ON r.id = p.request_id
     WHERE r.id IS NOT NULL OR p.dispatched_at < now() - interval '2 hours'
  ), written AS (
    INSERT INTO public.topshot_circulation_chain_audit
      (edition_external_id, checked_on, db_circulation, db_circulation_with_parallels,
       chain_circulation, agrees, status, checked_at)
    SELECT x.edition_external_id, current_date, x.db_circulation, x.db_total,
           x.chain_txt::int,
           -- ⛔ NULL, never false: a read that did not happen is not a disagreement.
           CASE WHEN x.chain_txt IS NOT NULL THEN (x.chain_txt::int = x.db_total) END,
           CASE WHEN x.status_code IS NULL          THEN 'no_response'
                WHEN x.status_code <> 200           THEN 'http_' || x.status_code
                WHEN x.chain_txt IS NULL            THEN 'undecodable'
                ELSE 'ok' END,
           now()
      FROM resolved x
    ON CONFLICT (edition_external_id, checked_on) DO UPDATE SET
      db_circulation                = EXCLUDED.db_circulation,
      db_circulation_with_parallels = EXCLUDED.db_circulation_with_parallels,
      chain_circulation             = EXCLUDED.chain_circulation,
      agrees                        = EXCLUDED.agrees,
      status                        = EXCLUDED.status,
      checked_at                    = EXCLUDED.checked_at
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM written;

  DELETE FROM public.topshot_circulation_chain_pending p
   WHERE EXISTS (SELECT 1 FROM net._http_response r WHERE r.id = p.request_id)
      OR p.dispatched_at < now() - interval '2 hours';

  RETURN jsonb_build_object(
    'ok', true,
    'recorded', v_rows,
    'still_pending', (SELECT count(*) FROM public.topshot_circulation_chain_pending),
    'lifetime', (SELECT jsonb_build_object(
                   'rows', count(*),
                   'read_ok', count(*) FILTER (WHERE status = 'ok'),
                   'agree', count(*) FILTER (WHERE agrees),
                   'db_low', count(*) FILTER (WHERE agrees = false AND chain_circulation > db_circulation_with_parallels),
                   'db_high', count(*) FILTER (WHERE agrees = false AND chain_circulation < db_circulation_with_parallels),
                   'has_parallels', count(*) FILTER (WHERE db_circulation_with_parallels > db_circulation),
                   'not_read', count(*) FILTER (WHERE chain_circulation IS NULL))
                 FROM public.topshot_circulation_chain_audit)
  );
END;
$function$;

-- anon-exec: NOT intentional for collect_topshot_circulation_sample — ops writer, revoked on the next line.
REVOKE EXECUTE ON FUNCTION public.collect_topshot_circulation_sample() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collect_topshot_circulation_sample() TO postgres, service_role;

COMMENT ON FUNCTION public.collect_topshot_circulation_sample() IS
  'Resolves in-flight #120 circulation probes. `agrees` compares the chain against BASE + PARALLELS, '
  'because TopShot.getNumMomentsInEdition counts every moment minted for a (set, play) while '
  'editions.circulation_count on a base row counts the base only — comparing them directly was the '
  '#120 misdiagnosis. A response that never landed is no_response with NULL agrees, never agreement.';

-- ── verification, same transaction ───────────────────────────────────────────
DO $verify$
DECLARE
  v_null int;
  v_flipped int;
BEGIN
  SELECT count(*) INTO v_null FROM public.topshot_circulation_chain_audit
   WHERE db_circulation_with_parallels IS NULL;
  IF v_null <> 0 THEN
    RAISE EXCEPTION '% audit rows still lack db_circulation_with_parallels', v_null;
  END IF;

  -- The four rows already written are zero-parallel editions, so the new
  -- definition must not change any verdict. Assert it rather than assume it.
  SELECT count(*) INTO v_flipped FROM public.topshot_circulation_chain_audit
   WHERE chain_circulation IS NOT NULL
     AND agrees IS DISTINCT FROM (chain_circulation = db_circulation_with_parallels);
  IF v_flipped <> 0 THEN
    RAISE EXCEPTION '% existing audit verdicts disagree with the corrected definition', v_flipped;
  END IF;
END
$verify$;
