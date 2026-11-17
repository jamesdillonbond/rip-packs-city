-- audit_20260922_wmc_edition_key_fill_refuses_a_serial_its_edition_cannot_hold
--
-- The two-source corroboration gate is NOT sufficient on its own, and 8 of the 3,276 rows
-- filled by 20260922190111 prove it: every one has moments.serial_number > the filled
-- edition's circulation_count (e.g. serial 476 in an edition of 49; serial 1875 in 1000).
-- Those 8 were WRITTEN BY THIS SESSION and are reverted below. This migration is a
-- correction of my own change, not of someone else's.
--
-- ── WHY THE GATE LET THEM THROUGH: THE CORROBORATION WAS CIRCULAR ──────────────
-- All 8 were corroborated by sales.edition_id agreeing with the proposed key. But
-- remap_misattributed_topshot_sales sets sales.edition_id FROM
-- wallet_moments_cache.edition_key -- its own comment records exactly this class:
--     "wmc is the SOURCE of (ek, ser) here and this function copied it verbatim, so a
--      wrong wmc subedition key became a wrong `sales` row with no check in between --
--      measured as 37 impossible rows, every one a byte-exact copy of wmc, all
--      contradicted by the canonical moments -> editions map."
-- So `sales` is DOWNSTREAM of wmc, not an independent witness. A wrong key can corroborate
-- itself through it. ⚠ Two sources agreeing is only evidence when their LINEAGE is
-- independent -- check what WRITES a table before counting it as a second opinion.
-- (topshot_moment_subeditions remains genuinely independent; it is the on-chain subedition
-- authority and is not written from wmc.)
--
-- ── THE CONTROL I WRONGLY DECLARED UNAVAILABLE ─────────────────────────────────
-- The arithmetic test is serial > circulation_count. wallet_moments_cache.serial_number is
-- NULL on every one of these candidates, so the pre-fill check returned impossible=0 AND
-- consistent=0 and was dismissed as vacuous -- correctly, for THAT column. But
-- moments.serial_number is NOT null: it is populated on all 1,369 remaining candidates and
-- on all 3,276 filled ones, and it comes from the same join the fill already performs.
-- ⭐ A probe that cannot see the property is not a measurement -- but before concluding the
-- property is unobservable, check whether ANOTHER table in the same join carries it.
--
-- Strictly SUBTRACTIVE: the guard can only REFUSE a fill, never create one, so it cannot
-- introduce a mis-key of its own. The NULL escapes keep unknown-circulation editions
-- behaving exactly as before. Same guard shape the codebase already uses in
-- remap_topshot_wmc_parallel_to_base_misattributed and the trophy path.
--
-- ── VERIFIED BY POSITIVE CONTROL ───────────────────────────────────────────────
-- After the revert the 8 rows are candidates again and their (circular) corroboration
-- still passes, so a full-window run is obliged to refuse them. It returned
--     {"window": 16357, "filled": 0, "refused_impossible_serial": 10}
-- 10 = the 8 reverted here + the 2 pre-existing impossible rows already known among the
-- 1,369 remaining candidates -- the predicted number exactly, and filled: 0 confirms none
-- were re-written.
--
-- REVERT: restore the function body from 20260922190912 and re-run the fill; the 8 reverted
--   rows carry reverted_at/reverted_reason in audit_20260922_wmc_edition_key_backfill.
--
-- anon-exec: revoked, NOT anon-reachable — reconcile_wmc_edition_key_from_moments had its ACL fixed by 20260922191908 (REVOKE EXECUTE FROM PUBLIC, anon, authenticated)
-- Why a marker and not a REVOKE here: this is a CREATE OR REPLACE body change, and
-- CREATE OR REPLACE does NOT reset a function ACL — a REVOKE in this file would change
-- production while pretending to be a body-only edit. Verified against pg_proc.proacl
-- ({postgres=X,service_role=X}; anon and authenticated both FALSE), not inferred.

ALTER TABLE public.audit_20260922_wmc_edition_key_backfill
  ADD COLUMN IF NOT EXISTS reverted_at     timestamptz,
  ADD COLUMN IF NOT EXISTS reverted_reason text;

-- 1. The guard, added BEFORE the revert so the next :21 tick cannot re-fill these rows.
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
  v_refused integer := 0;
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

  -- uuid has NO max() aggregate in Postgres (42883).
  SELECT count(*) INTO v_avail FROM _wek_win;
  SELECT win.id INTO v_high FROM _wek_win win ORDER BY win.id DESC LIMIT 1;
  IF v_high IS NULL THEN v_high := v_cursor; END IF;

  IF v_avail > 0 THEN
    CREATE TEMP TABLE _wek_ok ON COMMIT DROP AS
    WITH cand AS (
      SELECT win.id, e.external_id AS proposed_key, win.moment_id,
             m.serial_number AS m_serial, e.circulation_count AS e_circ,
        (SELECT es.external_id FROM public.sales s
           JOIN public.editions es ON es.id = s.edition_id
          WHERE s.nft_id = win.moment_id AND s.collection_id = v_ts
            AND s.edition_id IS NOT NULL LIMIT 1) AS sales_key,
        (SELECT sub.base_external_id FROM public.topshot_moment_subeditions sub
          WHERE sub.nft_id = win.moment_id LIMIT 1) AS sub_base_key
      FROM _wek_win win
      JOIN public.moments  m ON m.nft_id = win.moment_id AND m.collection_id = v_ts
      JOIN public.editions e ON e.id = m.edition_id
    )
    SELECT c.* FROM cand c
     WHERE ( (c.sales_key    IS NOT NULL AND c.sales_key    = c.proposed_key)
          OR (c.sub_base_key IS NOT NULL AND c.sub_base_key = split_part(c.proposed_key,'::',1)) )
       AND NOT (c.sales_key    IS NOT NULL AND c.sales_key    <> c.proposed_key)
       AND NOT (c.sub_base_key IS NOT NULL AND c.sub_base_key <> split_part(c.proposed_key,'::',1))
       -- ARITHMETIC GUARD: refuse a serial the proposed edition cannot hold. Subtractive
       -- only; NULL circulation/serial behaves exactly as before.
       AND NOT (c.m_serial IS NOT NULL AND c.e_circ IS NOT NULL AND c.m_serial > c.e_circ);

    SELECT count(*) INTO v_refused
      FROM _wek_win win
      JOIN public.moments  m ON m.nft_id = win.moment_id AND m.collection_id = v_ts
      JOIN public.editions e ON e.id = m.edition_id
     WHERE m.serial_number IS NOT NULL AND e.circulation_count IS NOT NULL
       AND m.serial_number > e.circulation_count;

    WITH logged AS (
      INSERT INTO public.audit_20260922_wmc_edition_key_backfill
             (id, wallet_address, moment_id, filled_key, sales_key, sub_base_key, filled_at)
      SELECT k.id, w.wallet_address, k.moment_id, k.proposed_key, k.sales_key, k.sub_base_key, now()
        FROM _wek_ok k JOIN public.wallet_moments_cache w ON w.id = k.id
      ON CONFLICT (id) DO NOTHING
    ),
    upd AS (
      UPDATE public.wallet_moments_cache w
         SET edition_key = k.proposed_key
        FROM _wek_ok k
       WHERE w.id = k.id
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
      'window', v_avail, 'filled', v_filled, 'refused_impossible_serial', v_refused,
      'budget_s', p_budget_seconds, 'via', 'pg_cron', 'no_op', (v_filled = 0)));

  RETURN jsonb_build_object('window', v_avail, 'filled', v_filled,
                            'refused_impossible_serial', v_refused, 'cursor', v_high);
END
$fn$;

-- 2. Mark the 8 bad fills in the revert ledger (keep the row; it records what was written).
UPDATE public.audit_20260922_wmc_edition_key_backfill b
   SET reverted_at = now(),
       reverted_reason = 'moments.serial_number > editions.circulation_count for the filled key; corroboration was circular via sales<-wmc'
  FROM public.wallet_moments_cache w
  JOIN public.moments  m ON m.nft_id = w.moment_id AND m.collection_id = w.collection_id
  JOIN public.editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
 WHERE b.id = w.id
   AND m.serial_number > e.circulation_count;

-- 3. Revert those rows to an honest unknown. The metadata sweep COALESCE-filled
--    player/set/tier/team/mint FROM THE WRONG EDITION, so clearing edition_key alone would
--    leave a fabricated player behind that OUTLIVES the key -- the reverted row would still
--    publish "Giannis Antetokounmpo" with no key to explain it. audit_20260904_* records
--    old_* = NULL for all 8, so NULL is an exact restore, not a guess.
UPDATE public.wallet_moments_cache w
   SET edition_key = NULL,
       player_name = NULL,
       set_name    = NULL,
       tier        = NULL,
       team_name   = NULL,
       mint_count  = NULL
  FROM public.audit_20260922_wmc_edition_key_backfill b
 WHERE b.id = w.id
   AND b.reverted_at IS NOT NULL
   AND w.edition_key = b.filled_key;
