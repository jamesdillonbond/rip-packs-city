-- audit_20260904_wmc_metadata_reconcile_corrects_truncated_and_placeholder_set_names_the_fill_only_selfheal_can_never_touch
-- Applied to prod via MCP apply_migration 2026-09-04 14:17Z (version 20260904141708).
-- First measured tick: 400 editions / 2.9 s / 287 rows corrected. ⚠ A 4,000-edition tick exceeds the
--   MCP 60 s call wall and rolls back cleanly (cursor unchanged, nothing logged) — size by the CALLER's
--   wall, not the function's `statement_timeout`. The cron was re-pointed after apply to
--   `*/10 * * * *` at 1,200 editions (~9 s/tick, full catalog ≈ 4 h) to burn the backlog down; once
--   `corrected` stays 0 for a whole cycle it can drop back to `19,29 * * * *`.
--
-- FINDING (2026-09-04, Atlas diff → traced to the wrong table). The audit flagged 1,709 Moments
-- whose `set_name` disagreed with Top Shot ("Rookie Debut6" vs "Rookie Debut"). The catalog is NOT
-- the wrong side — `editions.set_name` matches Atlas exactly. **`wallet_moments_cache` is the
-- corrupted side**, and the corruption is visible in the shape of it:
--     "Archive Set 1986-"   vs  "Archive Set 1986-87"   (truncated mid-value)
--     "Base Set6"           vs  "Base Set"              (stray digit)
--     "Set "                vs  "Clamps" / "Dynamic Duos"  (placeholder)
--     "Rookie Debut6"       vs  "Rookie Debut"
-- Measured across the 1,910,845 Top Shot rows: **91,180 wrong `set_name`, 2,952 wrong `tier`,
-- 14,711 wrong/blank `player_name`, 212 wrong `team_name`.** This is what a collector reads on their
-- own collection tab, and what the set/tier facets group by.
--
-- WHY NOTHING FIXED IT: `backfill_wmc_metadata_from_editions` is **COALESCE fill-only, by design** —
-- it fills a NULL and never corrects a wrong value, so a row written badly at seed time stays badly
-- written forever. (It also cannot fill an EMPTY STRING, which is not NULL — that is the shape of
-- most of the 14,711 blank player names, all of them team Moments.)
--
-- FIX — a corrective pass, deliberately narrower than the drift it found:
--   • `tier` and `set_name` are OVERWRITTEN from the catalog. Both were verified against Atlas on a
--     sample; the catalog is right and wmc is truncated/placeholder text.
--   • `player_name` and `team_name` are only filled where wmc is NULL **or empty** — never
--     overwritten, because the diacritic differences go BOTH ways ("Aleksej Pokuševski" is right in
--     wmc and stripped in editions; "Boban Marjanović" is the reverse). Blanket-syncing those would
--     trade one wrong name for another.
--   • ⛔ `mint_count` is NOT touched. `editions.circulation_count` is the chain's all-printings total
--     (284 where Top Shot shows the Standard's 249) and that semantic is an OPEN PRODUCT CALL for
--     Trevor — see the 2026-09-04 ledger entry. Writing 360,422 rows to one side of an undecided
--     question is exactly the mistake to avoid.
-- Cursor walk over the catalog, wrapping at the end so later corruption is caught; every corrected
-- row's old values are kept.
-- anon-exec: no — reconcile_wmc_metadata_from_editions is a writer; REVOKE … FROM PUBLIC, anon,
--   authenticated below; postgres/service_role/cron_heavy only.
-- REVERT: UPDATE wallet_moments_cache w SET tier = a.old_tier, set_name = a.old_set_name,
--   player_name = a.old_player_name, team_name = a.old_team_name
--   FROM audit_20260904_wmc_metadata_reconcile a WHERE a.wmc_id = w.id;
--   SELECT cron.unschedule('rpc-wmc-metadata-reconcile');

CREATE TABLE IF NOT EXISTS public.audit_20260904_wmc_metadata_reconcile (
  wmc_id          uuid PRIMARY KEY,
  edition_key     text NOT NULL,
  old_tier        text,
  old_set_name    text,
  old_player_name text,
  old_team_name   text,
  applied_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260904_wmc_metadata_reconcile ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260904_wmc_metadata_reconcile FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.audit_20260904_wmc_metadata_reconcile TO postgres, service_role, cron_heavy;

CREATE TABLE IF NOT EXISTS public.wmc_metadata_reconcile_state (
  id          integer PRIMARY KEY,
  cursor_key  text NOT NULL DEFAULT '',
  cycles      integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wmc_metadata_reconcile_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wmc_metadata_reconcile_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.wmc_metadata_reconcile_state TO postgres, service_role, cron_heavy;

CREATE OR REPLACE FUNCTION public.reconcile_wmc_metadata_from_editions(p_editions integer DEFAULT 400)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_cursor text;
  v_next   text;
  v_scanned integer := 0;
  v_n integer := 0;
  v_ok boolean := true;
  v_err text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('reconcile_wmc_metadata_from_editions')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  INSERT INTO public.wmc_metadata_reconcile_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT cursor_key INTO v_cursor FROM public.wmc_metadata_reconcile_state WHERE id = 1;

  BEGIN
    DROP TABLE IF EXISTS _wmr_eds;
    CREATE TEMP TABLE _wmr_eds ON COMMIT DROP AS
      SELECT e.external_id, e.tier::text AS tier, e.set_name, e.player_name, e.team_name
        FROM public.editions e
       WHERE e.collection_id = v_ts
         AND e.external_id > v_cursor
       ORDER BY e.external_id
       LIMIT GREATEST(p_editions, 1);
    SELECT count(*), max(external_id) INTO v_scanned, v_next FROM _wmr_eds;

    WITH cand AS (
      SELECT w.id, w.edition_key,
             w.tier AS old_tier, w.set_name AS old_set_name, w.player_name AS old_player_name, w.team_name AS old_team_name,
             CASE WHEN e.tier IS NOT NULL THEN e.tier ELSE w.tier END AS new_tier,
             CASE WHEN e.set_name IS NOT NULL THEN e.set_name ELSE w.set_name END AS new_set_name,
             -- fill-only (NULL or empty), never overwrite: diacritics differ in both directions
             CASE WHEN COALESCE(w.player_name, '') = '' THEN COALESCE(e.player_name, e.team_name, w.player_name) ELSE w.player_name END AS new_player_name,
             CASE WHEN COALESCE(w.team_name, '')   = '' THEN COALESCE(e.team_name, w.team_name)                 ELSE w.team_name   END AS new_team_name
        FROM _wmr_eds e
        JOIN public.wallet_moments_cache w
          ON w.collection_id = v_ts AND w.edition_key = e.external_id
    ),
    changed AS (
      SELECT * FROM cand
       WHERE new_tier        IS DISTINCT FROM old_tier
          OR new_set_name    IS DISTINCT FROM old_set_name
          OR new_player_name IS DISTINCT FROM old_player_name
          OR new_team_name   IS DISTINCT FROM old_team_name
    ),
    logged AS (
      INSERT INTO public.audit_20260904_wmc_metadata_reconcile (wmc_id, edition_key, old_tier, old_set_name, old_player_name, old_team_name)
      SELECT id, edition_key, old_tier, old_set_name, old_player_name, old_team_name FROM changed
      ON CONFLICT (wmc_id) DO NOTHING
    ),
    upd AS (
      UPDATE public.wallet_moments_cache w
         SET tier        = c.new_tier,
             set_name    = c.new_set_name,
             player_name = c.new_player_name,
             team_name   = c.new_team_name
        FROM changed c
       WHERE w.id = c.id
      RETURNING 1
    )
    SELECT count(*)::int INTO v_n FROM upd;

    UPDATE public.wmc_metadata_reconcile_state
       SET cursor_key = CASE WHEN v_scanned > 0 THEN COALESCE(v_next, cursor_key) ELSE '' END,
           cycles     = cycles + CASE WHEN v_scanned > 0 THEN 0 ELSE 1 END,
           updated_at = now()
     WHERE id = 1;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_err := SQLSTATE || ': ' || SQLERRM;
  END;

  IF v_n > 0 OR NOT v_ok THEN
    PERFORM public.log_pipeline_run('wmc-metadata-reconcile', v_started, v_scanned, v_n, 0, v_ok, v_err, 'nba_top_shot', v_cursor, v_next,
              jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                 'editions_scanned', v_scanned, 'rows_corrected', v_n, 'via', 'pg_cron'));
  END IF;
  RETURN jsonb_build_object('editions', v_scanned, 'corrected', v_n, 'cursor', v_next, 'ok', v_ok, 'error', v_err);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.reconcile_wmc_metadata_from_editions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_wmc_metadata_from_editions(integer) TO postgres, service_role, cron_heavy;

-- Applied as `19,29 * * * *` at 400 editions; re-pointed after the first measured tick to
-- `*/10 * * * *` at 1,200 (see the header). A fresh database can schedule either.
SELECT cron.schedule('rpc-wmc-metadata-reconcile', '*/10 * * * *', $$SELECT public.reconcile_wmc_metadata_from_editions(1200)$$);
