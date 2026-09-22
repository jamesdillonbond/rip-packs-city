-- audit_20260922_impossible_serial_guard_uses_base_plus_parallels_not_base_alone
--
-- Corrects the arithmetic guard added in 20260922195219. The guard was right to refuse the
-- 8 rows it refused, but its DENOMINATOR is wrong in general.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────────
-- Top Shot assigns serialNumber within the whole (setID, playID) edition, SHARED across the
-- base printing and every parallel subedition. editions.circulation_count on a BASE row is
-- the BASE-ONLY count by design -- collect_topshot_circulation_sample states it outright:
--     "The comparable quantity: base + parallels. The chain counts the TOTAL minted for a
--      (set, play); the base row counts the base."
-- So `serial > base circulation_count` flags legitimate rows whenever the edition has
-- parallels. Measured over the 144 rows the old formula flags estate-wide: 37 are FALSE
-- POSITIVES (legitimate under base+parallels) and 107 are genuinely impossible -- a ~26%
-- false-positive rate on the population it is used to judge.
--
-- ⚠ This did NOT produce a wrong revert: all 8 rows reverted by 20260922195219 have ZERO
-- parallels, so base-only IS their true total and they remain impossible under the correct
-- denominator (re-verified per row). The guard was over-broad, not wrong on those, and a
-- full-window run after this change still returns refused_impossible_serial = 10 -- the
-- same 10, because every one of them has no parallels.
--
-- ── HOW THE ERROR WAS FOUND, WHICH IS THE PART WORTH KEEPING ───────────────────
-- I sampled 60 base editions against mainnet getNumMomentsInEdition and found 12
-- "understated" circulation_counts -- a 20% catalog-drift finding I was about to file.
-- It was an ARTIFACT of comparing two different quantities: base-only against the chain's
-- base+parallels total. Re-compared correctly, all 12 agree EXACTLY. The estate already
-- measures this properly in topshot_circulation_chain_audit (356 agree / 1 disagree /
-- 50 pending over 9 days) and was right all along.
-- ⛔ A DIFFERENCE NEEDS BOTH SIDES COUNTED BY THE SAME INSTRUMENT. Before publishing a
-- drift number, read the column's own definition and check whether an existing instrument
-- already measures it -- this one did, and disagreed with me.
--
-- The correct denominator for any key K is the total for its BASE edition:
--     sum(circulation_count) over {base(K)} U {base(K)::*}
-- which equals getNumMomentsInEdition(setID, playID) on chain -- spot-checked against
-- mainnet for 12 editions, all 12 agreeing once compared this way.
--
-- Still strictly SUBTRACTIVE (can only refuse, never create), still NULL-escaping.
--
-- ⚠ SEPARATE, PRE-EXISTING, NOT FIXED HERE: 107 keyed wmc rows across 37 wallets are
-- genuinely impossible under the correct denominator, and ALL 107 are on SEEDED
-- (user-facing) wallets -- a collector sees e.g. "#1875/1000". 16 are parallel-keyed and
-- are the case remap_topshot_wmc_parallel_to_base_misattributed deliberately EXCLUDES (the
-- subedition authority positively assigns them to that parallel); the rest are base-keyed
-- and no remap covers base-keyed rows at all. `moments` offers no correction: 124 of 128
-- have no moments row, and where it has an opinion it AGREES with the impossible key.
-- Filed rather than fixed -- deciding whether the serial or the key is wrong needs
-- per-moment on-chain resolution.
--
-- anon-exec: revoked, NOT anon-reachable — reconcile_wmc_edition_key_from_moments had its ACL fixed by 20260922191908 (REVOKE EXECUTE FROM PUBLIC, anon, authenticated)
-- CREATE OR REPLACE does not reset a function ACL, so a REVOKE here would change production
-- while pretending to be a body-only edit; verified against pg_proc.proacl.
--
-- REVERT: restore the body from 20260922195219.

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
    CREATE TEMP TABLE _wek_cand ON COMMIT DROP AS
      SELECT win.id, e.external_id AS proposed_key, win.moment_id,
             m.serial_number AS m_serial,
             -- TRUE denominator: the (set, play) total = base + every parallel, which is what
             -- the on-chain serial space spans. NOT the base row's own circulation_count.
             (SELECT sum(t.circulation_count) FROM public.editions t
               WHERE t.collection_id = v_ts
                 AND (t.external_id = split_part(e.external_id,'::',1)
                   OR t.external_id LIKE split_part(e.external_id,'::',1) || '::%')) AS edition_total,
        (SELECT es.external_id FROM public.sales s
           JOIN public.editions es ON es.id = s.edition_id
          WHERE s.nft_id = win.moment_id AND s.collection_id = v_ts
            AND s.edition_id IS NOT NULL LIMIT 1) AS sales_key,
        (SELECT sub.base_external_id FROM public.topshot_moment_subeditions sub
          WHERE sub.nft_id = win.moment_id LIMIT 1) AS sub_base_key
      FROM _wek_win win
      JOIN public.moments  m ON m.nft_id = win.moment_id AND m.collection_id = v_ts
      JOIN public.editions e ON e.id = m.edition_id;

    CREATE TEMP TABLE _wek_ok ON COMMIT DROP AS
      SELECT c.* FROM _wek_cand c
       WHERE ( (c.sales_key    IS NOT NULL AND c.sales_key    = c.proposed_key)
            OR (c.sub_base_key IS NOT NULL AND c.sub_base_key = split_part(c.proposed_key,'::',1)) )
         AND NOT (c.sales_key    IS NOT NULL AND c.sales_key    <> c.proposed_key)
         AND NOT (c.sub_base_key IS NOT NULL AND c.sub_base_key <> split_part(c.proposed_key,'::',1))
         AND NOT (c.m_serial IS NOT NULL AND c.edition_total IS NOT NULL
                  AND c.m_serial > c.edition_total);

    SELECT count(*) INTO v_refused FROM _wek_cand c
     WHERE c.m_serial IS NOT NULL AND c.edition_total IS NOT NULL
       AND c.m_serial > c.edition_total;

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
