-- The reconcile shipped three hours ago with an explicit refusal in its own header:
--   "⛔ `mint_count` is not touched at all: `editions.circulation_count` is the chain's
--    all-printings total (284 where Top Shot shows 249) and that is the open product call —
--    writing 360,422 rows to one side of an undecided question is precisely the mistake to avoid."
-- ⭐ THAT QUESTION IS NOW DECIDED (migrations 20260904145331 / 145452, on the measurement that
-- 1,312 of 9,473 base editions differed from Atlas by EXACTLY the sum of their parallels' mints and
-- zero were unexplained). `editions.circulation_count` means **this printing's own mint**. So the
-- refusal has expired, and the denorm has to follow the column it denormalises.
--
-- MEASURED NOW, over the 1,910,846 Top Shot wmc rows that join an edition:
--   • **539,596 rows carry a `mint_count` that disagrees** with the corrected catalog value.
--   • **539,326 of those are OVERSTATED** — only 270 understated, 211 NULL.
--   • Split by key shape, and the parallel half is the severe one:
--       base     421,618 rows over 2,039 editions, mean ratio **1.24x** — the all-printings total,
--                exactly the 284-vs-249 shape, now stale by construction.
--       parallel 117,708 rows over 3,540 editions, mean ratio **16.5x**, and
--                **66,376 of them are more than 10x the true mint.**
-- ⚠ THE PARALLEL HALF IS DEBRIS FROM MY OWN RE-KEY EARLIER TODAY. `upsert_wmc_batch` was fixed to
-- resolve a Top Shot parallel at write time and 67,530 rows were re-keyed from `set:play` to
-- `set:play::N` — which moved `edition_key` and left `mint_count` holding the BASE edition's count.
-- A Jukebox /9 in a collector's tab therefore reads its serial against a number ~16x too large. A
-- fix that leaves a worse number behind than it found is not finished; this finishes it.
--
-- WHERE IT SHOWS. The main collection tab is safe — `get_wallet_moments_with_fmv` selects
-- `e.circulation_count` straight from `editions`, so it was corrected by the migrations above. But
-- `wmc.mint_count` is read directly by `/api/profile/hero-moment`, both `/api/support-chat` Moment
-- lookups, and the trophy picker, each rendering `#serial/mint`. Those are the surfaces still lying.
--
-- SCOPE, unchanged from the parent reconcile: Top Shot only, and `circulation_count` must be
-- NOT NULL — a NULL in the catalog never overwrites a value wmc already has (removing a denominator
-- is its own kind of wrong, and the catalog has gaps Atlas has not walked yet).
--
-- The cursor is reset to '' so the ~40 % of the catalog this cycle already passed gets the new
-- column too, rather than waiting a full wrap. The re-walk is cheap for the four columns that have
-- already converged (last ticks: 191 and 278 rows, down from 34,071).
-- anon-exec: the reconcile keeps its existing REVOKE … FROM PUBLIC, anon, authenticated;
--   postgres/service_role/cron_heavy only. Signature is UNCHANGED, so no new overload is created.
-- REVERT: UPDATE wallet_moments_cache w SET mint_count = a.old_mint_count
--           FROM public.audit_20260904_wmc_mint_count a WHERE a.wmc_id = w.id;
--         then restore the prior function body (this file's parent, 20260904142504).

CREATE TABLE IF NOT EXISTS public.audit_20260904_wmc_mint_count (
  wmc_id         uuid PRIMARY KEY,
  edition_key    text NOT NULL,
  old_mint_count integer,
  new_mint_count integer NOT NULL,
  applied_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260904_wmc_mint_count ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260904_wmc_mint_count FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.audit_20260904_wmc_mint_count TO postgres, service_role, cron_heavy;

CREATE OR REPLACE FUNCTION public.reconcile_wmc_metadata_from_editions(p_editions integer DEFAULT 1200, p_budget_seconds integer DEFAULT 45)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started  timestamptz := clock_timestamp();
  v_deadline timestamptz := clock_timestamp() + make_interval(secs => GREATEST(p_budget_seconds, 5));
  v_cursor  text;
  v_high    text;      -- highest edition key actually processed this tick
  v_avail   integer := 0;
  v_n       integer := 0;
  v_batch   integer;
  v_popmax  text;
  v_chunk   constant integer := 25;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('reconcile_wmc_metadata_from_editions')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  INSERT INTO public.wmc_metadata_reconcile_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT cursor_key INTO v_cursor FROM public.wmc_metadata_reconcile_state WHERE id = 1;
  v_high := v_cursor;

  DROP TABLE IF EXISTS _wmr_eds;
  CREATE TEMP TABLE _wmr_eds ON COMMIT DROP AS
    SELECT e.external_id, e.tier::text AS tier, e.set_name, e.player_name, e.team_name,
           e.circulation_count
      FROM public.editions e
     WHERE e.collection_id = v_ts
       AND e.external_id > v_cursor
     ORDER BY e.external_id
     LIMIT GREATEST(p_editions, 1);
  SELECT count(*) INTO v_avail FROM _wmr_eds;
  CREATE INDEX ON _wmr_eds (external_id);
  ANALYZE _wmr_eds;

  WHILE v_avail > 0 LOOP
    WITH popped AS (
      DELETE FROM _wmr_eds
       WHERE external_id IN (SELECT external_id FROM _wmr_eds ORDER BY external_id LIMIT v_chunk)
      RETURNING external_id, tier, set_name, player_name, team_name, circulation_count
    ),
    cand AS (
      SELECT w.id, w.edition_key,
             w.tier AS old_tier, w.set_name AS old_set_name, w.player_name AS old_player_name,
             w.team_name AS old_team_name, w.mint_count AS old_mint_count,
             CASE WHEN p.tier IS NOT NULL THEN p.tier ELSE w.tier END AS new_tier,
             CASE WHEN p.set_name IS NOT NULL THEN p.set_name ELSE w.set_name END AS new_set_name,
             CASE WHEN COALESCE(w.player_name, '') = '' THEN COALESCE(p.player_name, p.team_name, w.player_name) ELSE w.player_name END AS new_player_name,
             CASE WHEN COALESCE(w.team_name, '')   = '' THEN COALESCE(p.team_name, w.team_name)                 ELSE w.team_name   END AS new_team_name,
             -- The denominator now has ONE meaning (this printing's own mint) and the catalog owns
             -- it. A NULL catalog value never removes a number wmc already has.
             CASE WHEN p.circulation_count IS NOT NULL THEN p.circulation_count ELSE w.mint_count END AS new_mint_count
        FROM popped p
        JOIN public.wallet_moments_cache w
          ON w.collection_id = v_ts AND w.edition_key = p.external_id
    ),
    changed AS (
      SELECT * FROM cand
       WHERE new_tier        IS DISTINCT FROM old_tier
          OR new_set_name    IS DISTINCT FROM old_set_name
          OR new_player_name IS DISTINCT FROM old_player_name
          OR new_team_name   IS DISTINCT FROM old_team_name
          OR new_mint_count  IS DISTINCT FROM old_mint_count
    ),
    logged AS (
      INSERT INTO public.audit_20260904_wmc_metadata_reconcile (wmc_id, edition_key, old_tier, old_set_name, old_player_name, old_team_name)
      SELECT id, edition_key, old_tier, old_set_name, old_player_name, old_team_name FROM changed
      ON CONFLICT (wmc_id) DO NOTHING
    ),
    -- mint_count gets its OWN audit table rather than a column on the one above, because that one
    -- is ON CONFLICT DO NOTHING and rows fixed on an earlier tick would silently record no old
    -- mint at all — a revert path with holes in it is not a revert path.
    logged_mint AS (
      INSERT INTO public.audit_20260904_wmc_mint_count (wmc_id, edition_key, old_mint_count, new_mint_count)
      SELECT id, edition_key, old_mint_count, new_mint_count FROM changed
       WHERE new_mint_count IS DISTINCT FROM old_mint_count AND new_mint_count IS NOT NULL
      ON CONFLICT (wmc_id) DO NOTHING
    ),
    upd AS (
      UPDATE public.wallet_moments_cache w
         SET tier        = c.new_tier,
             set_name    = c.new_set_name,
             player_name = c.new_player_name,
             team_name   = c.new_team_name,
             mint_count  = c.new_mint_count
        FROM changed c
       WHERE w.id = c.id
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM upd), (SELECT max(external_id) FROM popped)
      INTO v_batch, v_popmax;

    v_n := v_n + COALESCE(v_batch, 0);
    IF v_popmax IS NOT NULL AND v_popmax > v_high THEN
      v_high := v_popmax;      -- ← the whole cursor rule
    END IF;

    EXIT WHEN v_popmax IS NULL;                              -- nothing left to pop
    EXIT WHEN NOT EXISTS (SELECT 1 FROM _wmr_eds);
    EXIT WHEN clock_timestamp() > v_deadline;
  END LOOP;

  UPDATE public.wmc_metadata_reconcile_state
     SET cursor_key = CASE WHEN v_avail > 0 THEN v_high ELSE '' END,   -- wrap when the catalog is exhausted
         cycles     = cycles + CASE WHEN v_avail > 0 THEN 0 ELSE 1 END,
         updated_at = now()
   WHERE id = 1;

  IF v_n > 0 THEN
    PERFORM public.log_pipeline_run('wmc-metadata-reconcile', v_started, v_avail, v_n, 0, true, NULL, 'nba_top_shot', v_cursor, v_high,
              jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                 'editions_window', v_avail, 'rows_corrected', v_n, 'budget_s', p_budget_seconds, 'via', 'pg_cron'));
  END IF;
  RETURN jsonb_build_object('window', v_avail, 'corrected', v_n, 'cursor', v_high);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.reconcile_wmc_metadata_from_editions(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_wmc_metadata_from_editions(integer, integer) TO postgres, service_role, cron_heavy;

-- Restart the walk so the ~40 % already passed this cycle picks up the new column.
UPDATE public.wmc_metadata_reconcile_state SET cursor_key = '', updated_at = now() WHERE id = 1;
