-- audit_20260922_wmc_edition_key_gains_a_healer_that_can_actually_see_a_null_key
--
-- Companion to 20260922190111 (the one-off fill). That migration filled 3,276 rows;
-- this one makes the fill PERMANENT so the defect cannot silently re-accumulate.
--
-- THE STRUCTURAL DEFECT. Top Shot wmc rows written by app/api/wallet-search (its
-- `unresolvedRows` path maps through a baseRow() with NO edition_key field, so the
-- INSERT omits the column) land with edition_key NULL. Both existing healers --
-- reconcile_wmc_metadata_from_editions and rpc_wmc_selfheal_recent -- MATCH ON
-- edition_key (`e.external_id = wmc.edition_key`, `wmc.edition_key IS NOT NULL`).
-- A NULL key is therefore invisible to every healer we have: those rows were not
-- awaiting a retry, they were permanently orphaned, rendering as a real holding with
-- no player and no FMV. Nothing in the estate could ever have fixed them.
--
-- THE RESOLUTION PATH no healer used: moment_id -> moments.nft_id -> moments.edition_id
-- -> editions.external_id.
--
-- THE GATE (identical to 20260922190111). A WRONG edition_key is a SUBSTITUTION defect --
-- it shows a collector another moment's player and FMV -- and is strictly worse than an
-- honest NULL. So a fill requires corroboration from >= 1 INDEPENDENT source and
-- contradiction from neither:
--     sales.nft_id -> sales.edition_id          (a different writer than `moments`)
--     topshot_moment_subeditions.nft_id         (a different writer again)
-- Measured over the 4,645 candidates: sales 2,570 agree / 20 disagree; subeditions
-- 2,005 agree / 13 disagree. ~99.3%, and NOT 100% -- the control demonstrably detects
-- disagreement rather than rubber-stamping. Uncorroborated rows KEEP THEIR NULL.
--
-- WALK PROGRESSION. The window is ordered by id behind a cursor in
-- wmc_edition_key_reconcile_state, and the cursor advances past rows that did NOT
-- resolve. A fixed `ORDER BY id LIMIT n` with no cursor would re-read its own head
-- forever and starve the tail, since unresolvable rows never leave the candidate set.
-- The cursor wraps to the zero uuid when the window comes back empty.
--
-- REVERT: drop the cron job (`SELECT cron.unschedule('rpc-wmc-edition-key-reconcile')`),
--   then DROP FUNCTION public.reconcile_wmc_edition_key_from_moments(integer, integer);
--   rows already filled are reverted via audit_20260922_wmc_edition_key_backfill exactly
--   as described in 20260922190111. The state table and index are inert once the
--   function is gone and may be left or dropped.
--
-- NOTE: the function body below is the AS-APPLIED version and contains a defect --
-- `max(id)` over a uuid, which does not exist in Postgres (42883). It is corrected by
-- the immediately following migration 20260922190912. Kept verbatim so the repo
-- reproduces what prod actually ran.

CREATE TABLE IF NOT EXISTS public.wmc_edition_key_reconcile_state (
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cursor_id  uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  cycles     integer     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wmc_edition_key_reconcile_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wmc_edition_key_reconcile_state FROM anon, authenticated;
INSERT INTO public.wmc_edition_key_reconcile_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Every other NULL-partial index on this table is `edition_key IS NOT NULL`; nothing
-- supported the IS NULL scan. 16,414 of 2,159,814 rows qualify, so this is tiny.
CREATE INDEX IF NOT EXISTS idx_wmc_edition_key_null
  ON public.wallet_moments_cache (collection_id, id)
  WHERE edition_key IS NULL;

CREATE OR REPLACE FUNCTION public.reconcile_wmc_edition_key_from_moments(
  p_rows integer DEFAULT 3000,
  p_budget_seconds integer DEFAULT 45
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '110s'
AS $fn$
DECLARE
  v_ts      constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_cursor  uuid;
  v_high    uuid;
  v_avail   integer := 0;
  v_filled  integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('reconcile_wmc_edition_key_from_moments')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  INSERT INTO public.wmc_edition_key_reconcile_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT st.cursor_id INTO v_cursor
    FROM public.wmc_edition_key_reconcile_state st WHERE st.id = 1;
  v_high := v_cursor;

  CREATE TEMP TABLE _wek_win ON COMMIT DROP AS
    SELECT w.id, w.moment_id
      FROM public.wallet_moments_cache w
     WHERE w.collection_id = v_ts
       AND w.edition_key IS NULL
       AND w.id > v_cursor
     ORDER BY w.id
     LIMIT GREATEST(p_rows, 1);
  SELECT count(*), max(id) INTO v_avail, v_high FROM _wek_win;
  IF v_high IS NULL THEN v_high := v_cursor; END IF;

  IF v_avail > 0 THEN
    WITH cand AS (
      SELECT win.id, e.external_id AS proposed_key, win.moment_id,
        (SELECT es.external_id FROM public.sales s
           JOIN public.editions es ON es.id = s.edition_id
          WHERE s.nft_id = win.moment_id AND s.collection_id = v_ts
            AND s.edition_id IS NOT NULL LIMIT 1) AS sales_key,
        (SELECT sub.base_external_id FROM public.topshot_moment_subeditions sub
          WHERE sub.nft_id = win.moment_id LIMIT 1) AS sub_base_key
      FROM _wek_win win
      JOIN public.moments  m ON m.nft_id = win.moment_id AND m.collection_id = v_ts
      JOIN public.editions e ON e.id = m.edition_id
    ),
    ok AS (
      SELECT c.* FROM cand c
       WHERE ( (c.sales_key    IS NOT NULL AND c.sales_key    = c.proposed_key)
            OR (c.sub_base_key IS NOT NULL AND c.sub_base_key = split_part(c.proposed_key,'::',1)) )
         AND NOT (c.sales_key    IS NOT NULL AND c.sales_key    <> c.proposed_key)
         AND NOT (c.sub_base_key IS NOT NULL AND c.sub_base_key <> split_part(c.proposed_key,'::',1))
    ),
    logged AS (
      INSERT INTO public.audit_20260922_wmc_edition_key_backfill
             (id, wallet_address, moment_id, filled_key, sales_key, sub_base_key, filled_at)
      SELECT ok.id, w.wallet_address, ok.moment_id, ok.proposed_key, ok.sales_key, ok.sub_base_key, now()
        FROM ok JOIN public.wallet_moments_cache w ON w.id = ok.id
      ON CONFLICT (id) DO NOTHING
    ),
    upd AS (
      UPDATE public.wallet_moments_cache w
         SET edition_key = ok.proposed_key
        FROM ok
       WHERE w.id = ok.id
         AND w.edition_key IS NULL
      RETURNING 1
    )
    SELECT count(*)::int INTO v_filled FROM upd;
  END IF;

  UPDATE public.wmc_edition_key_reconcile_state
     SET cursor_id  = CASE WHEN v_avail > 0 THEN v_high
                           ELSE '00000000-0000-0000-0000-000000000000'::uuid END,
         cycles     = cycles + CASE WHEN v_avail > 0 THEN 0 ELSE 1 END,
         updated_at = now()
   WHERE id = 1;

  PERFORM public.log_pipeline_run(
    'wmc-edition-key-reconcile', v_started, v_avail, v_filled, GREATEST(v_avail - v_filled, 0),
    true, NULL, 'nba_top_shot', v_cursor::text, v_high::text,
    jsonb_build_object(
      'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'window', v_avail, 'filled', v_filled, 'budget_s', p_budget_seconds,
      'via', 'pg_cron', 'no_op', (v_filled = 0)));

  RETURN jsonb_build_object('window', v_avail, 'filled', v_filled, 'cursor', v_high);
END
$fn$;

REVOKE ALL ON FUNCTION public.reconcile_wmc_edition_key_from_moments(integer, integer) FROM anon, authenticated;

COMMENT ON FUNCTION public.reconcile_wmc_edition_key_from_moments(integer, integer) IS
  'Fills wallet_moments_cache.edition_key for Top Shot rows left NULL by app/api/wallet-search (its unresolvedRows path omits the column). Those rows were permanently orphaned: reconcile_wmc_metadata_from_editions and rpc_wmc_selfheal_recent both MATCH ON edition_key, so a NULL key is invisible to every existing healer. Resolves moment_id -> moments.nft_id -> edition_id -> editions.external_id, gated on corroboration from sales.nft_id and/or topshot_moment_subeditions, and writes its revert ledger to audit_20260922_wmc_edition_key_backfill.';
