-- audit_20260904_upsert_wmc_batch_keys_a_resolved_parallel_at_write_time_and_a_oneshot_rekeys_the_67k_base_keyed_rows
-- Applied to prod via MCP apply_migration 2026-09-04 06:26Z (version 20260904062632).
--
-- FINDING (2026-09-04, the RPC-vs-Top-Shot audit of the founder wallet — all 15,183 Top Shot
-- Moments via Dapper's Atlas API from a browser): 1,264 of the wallet's 1,447 parallel Moments
-- (Jukebox, Hexwave, …) sat in wallet_moments_cache under the BASE setID:playID key — a Jukebox /9
-- valued and counted as a Standard /284 — even though topshot_moment_subeditions had resolved every
-- one of them on-chain. Platform-wide: 67,607 rows across 285 wallets. The daily
-- drain-conflated-subeditions split re-keys ~1,000/day, and upsert_wmc_batch's
-- `set edition_key = excluded.edition_key` put the base key BACK on every wallet re-walk (the
-- indexer's Cadence read carries setID:playID only). A treadmill.
-- FIX: (1) upsert_wmc_batch resolves the parallel at write time from topshot_moment_subeditions
-- (base::N, when that edition exists); the cost-control WHERE / 24 h clause / `written` contract
-- are unchanged and the supabase/tests pin is updated in the same commit. (2) a self-retiring
-- one-shot pg_cron job walks the resolved parallels behind a cursor and re-keys the base-keyed rows,
-- taking the parallel's current FMV (NULL when none — backfill_wmc_fmv_confidence fills it from
-- snapshots). Measured first tick: 3,000 scanned → 2,118 re-keyed in 19.4 s, so the schedule runs
-- 9,000/tick (`cron.alter_job` after apply; ~16 ticks). Old key/fmv kept in
-- audit_20260904_wmc_parallel_rekey.
-- anon-exec: no — upsert_wmc_batch keeps its acl (postgres/service_role; CREATE OR REPLACE on the
--   same signature); rekey_topshot_wmc_parallels REVOKE … FROM PUBLIC, anon, authenticated.
-- REVERT: UPDATE wallet_moments_cache w SET edition_key = a.old_key, fmv_usd = a.old_fmv,
--   fmv_confidence = a.old_conf FROM audit_20260904_wmc_parallel_rekey a WHERE a.wmc_id = w.id;
--   upsert_wmc_batch: the body in 20260812033600 (the snapshot pin before this one).

-- (1) upsert_wmc_batch resolves a Top Shot parallel at WRITE time. The indexer's Cadence read sees
--     setID:playID only (the subedition is a separate on-chain map), so every wallet re-walk sent the
--     BASE key and `set edition_key = excluded.edition_key` reverted each split row to the Standard
--     edition — measured 2026-09-04: 67,607 wmc rows across 285 wallets are on-chain-resolved
--     parallels keyed to base (916 in the founder wallet: a Jukebox /9 valued as a Standard /284),
--     while the daily split drain re-keys ~1,000/day. Treadmill. Same behaviour otherwise: the
--     cost-control WHERE, the 24 h anti-freeze clause, `written` = rows actually written.
CREATE OR REPLACE FUNCTION public.upsert_wmc_batch(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_total   int;
  v_written int;
begin
  v_total := coalesce(jsonb_array_length(p_rows), 0);
  if v_total = 0 then
    return jsonb_build_object('total', 0, 'written', 0);
  end if;

  with input as (
    select
      r.wallet_address,
      r.collection_id,
      r.moment_id,
      -- Top Shot only: a base setID:playID key whose nft is on-chain-resolved to a parallel
      -- (topshot_moment_subeditions.subedition_id > 0) and whose base::N edition exists is
      -- written as base::N. Unresolved, Standard (0), or not-yet-cataloged → the key as sent.
      case
        when r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         and r.edition_key ~ '^[0-9]+:[0-9]+$'
        then coalesce(
          (select sub.base_external_id || '::' || sub.subedition_id::text
             from public.topshot_moment_subeditions sub
            where sub.nft_id = r.moment_id
              and sub.base_external_id = r.edition_key
              and coalesce(sub.subedition_id, 0) > 0
              and exists (select 1 from public.editions e
                           where e.collection_id = r.collection_id
                             and e.external_id = sub.base_external_id || '::' || sub.subedition_id::text)),
          r.edition_key)
        else r.edition_key
      end as edition_key,
      r.serial_number,
      r.last_seen_at
    from jsonb_to_recordset(p_rows) as r(
      wallet_address text,
      collection_id  uuid,
      moment_id      text,
      edition_key    text,
      serial_number  integer,
      last_seen_at   timestamptz
    )
  ),
  upserted as (
    insert into public.wallet_moments_cache as w (
      wallet_address, collection_id, moment_id,
      edition_key, serial_number, last_seen_at
    )
    select
      wallet_address, collection_id, moment_id,
      edition_key, serial_number, coalesce(last_seen_at, now())
    from input
    on conflict (wallet_address, collection_id, moment_id) do update
      set edition_key   = excluded.edition_key,
          serial_number = excluded.serial_number,
          last_seen_at  = excluded.last_seen_at
      where w.edition_key   is distinct from excluded.edition_key
         or w.serial_number is distinct from excluded.serial_number
         or w.last_seen_at  < now() - interval '24 hours'
    returning 1
  )
  select count(*)::int into v_written from upserted;

  return jsonb_build_object('total', v_total, 'written', coalesce(v_written, 0));
end;
$function$;

-- (2) One-shot drain for the 67K rows already on base: rekey to base::N and take the parallel's
--     current FMV (NULL when the parallel has none — backfill_wmc_fmv_confidence then fills it
--     from snapshots; a Standard price on a Jukebox row is not a fallback, it is the defect).
CREATE TABLE IF NOT EXISTS public.audit_20260904_wmc_parallel_rekey (
  wmc_id      uuid PRIMARY KEY,
  old_key     text NOT NULL,
  new_key     text NOT NULL,
  old_fmv     numeric,
  old_conf    public.fmv_confidence,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260904_wmc_parallel_rekey ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260904_wmc_parallel_rekey FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.audit_20260904_wmc_parallel_rekey TO postgres, service_role, cron_heavy;

CREATE TABLE IF NOT EXISTS public.wmc_parallel_rekey_state (
  id         integer PRIMARY KEY,
  cursor_nft text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wmc_parallel_rekey_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wmc_parallel_rekey_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.wmc_parallel_rekey_state TO postgres, service_role, cron_heavy;

-- Walks topshot_moment_subeditions in nft_id order behind a cursor (p_scan rows per tick), so no
-- tick re-probes what an earlier tick already fixed. Measured: a LIMIT-driven restart cost 177K
-- buffers per 5,000 hits and grows as the candidates thin; the cursor walk is ~3 buffers per
-- scanned nft, once.
CREATE OR REPLACE FUNCTION public.rekey_topshot_wmc_parallels(p_scan integer DEFAULT 20000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  IF NOT pg_try_advisory_xact_lock(hashtext('rekey_topshot_wmc_parallels')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  INSERT INTO public.wmc_parallel_rekey_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT cursor_nft INTO v_cursor FROM public.wmc_parallel_rekey_state WHERE id = 1;
  BEGIN
    DROP TABLE IF EXISTS _rk_scan;
    CREATE TEMP TABLE _rk_scan ON COMMIT DROP AS
      SELECT sub.nft_id, sub.base_external_id, sub.subedition_id
        FROM public.topshot_moment_subeditions sub
       WHERE sub.nft_id > v_cursor
         AND coalesce(sub.subedition_id, 0) > 0        -- Standard rows have nothing to rekey
       ORDER BY sub.nft_id
       LIMIT GREATEST(p_scan, 1);
    SELECT count(*), max(nft_id) INTO v_scanned, v_next FROM _rk_scan;

    WITH cand AS (
      SELECT w.id, w.edition_key AS old_key, w.fmv_usd AS old_fmv, w.fmv_confidence AS old_conf,
             se.external_id AS new_key, l.fmv_usd AS new_fmv, l.confidence AS new_conf
        FROM _rk_scan sub
        JOIN public.wallet_moments_cache w
          ON w.moment_id = sub.nft_id
         AND w.collection_id = v_ts
         AND w.edition_key = sub.base_external_id
        JOIN public.editions se
          ON se.collection_id = v_ts
         AND se.external_id = sub.base_external_id || '::' || sub.subedition_id::text
        LEFT JOIN public.edition_fmv_current l ON l.edition_id = se.id
       WHERE coalesce(sub.subedition_id, 0) > 0
    ),
    logged AS (
      INSERT INTO public.audit_20260904_wmc_parallel_rekey (wmc_id, old_key, new_key, old_fmv, old_conf)
      SELECT id, old_key, new_key, old_fmv, old_conf FROM cand
      ON CONFLICT (wmc_id) DO NOTHING
    ),
    upd AS (
      UPDATE public.wallet_moments_cache w
         SET edition_key    = c.new_key,
             fmv_usd        = c.new_fmv,
             fmv_confidence = c.new_conf
        FROM cand c
       WHERE w.id = c.id
      RETURNING 1
    )
    SELECT count(*)::int INTO v_n FROM upd;

    UPDATE public.wmc_parallel_rekey_state
       SET cursor_nft = COALESCE(v_next, cursor_nft), updated_at = now()
     WHERE id = 1;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM public.log_pipeline_run('wmc-parallel-rekey', v_started, v_scanned, v_n, 0, v_ok, v_err, 'nba_top_shot', v_cursor, v_next,
            jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int, 'scan', p_scan, 'via', 'pg_cron'));
  -- Self-retiring: once the walk has passed the last nft_id, the one-shot schedule removes itself.
  IF v_ok AND v_scanned = 0 THEN
    PERFORM cron.unschedule('rpc-wmc-parallel-rekey-oneshot');
  END IF;
  RETURN jsonb_build_object('scanned', v_scanned, 'rekeyed', v_n, 'cursor', v_next, 'ok', v_ok, 'error', v_err);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.rekey_topshot_wmc_parallels(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rekey_topshot_wmc_parallels(integer) TO postgres, service_role, cron_heavy;

-- One-shot, every 2 min as postgres (statement_timeout ~2 min; 9,000 nfts ≈ 58 s measured);
-- retires itself when the cursor passes the last nft_id.
SELECT cron.schedule('rpc-wmc-parallel-rekey-oneshot', '*/2 * * * *', $$SELECT public.rekey_topshot_wmc_parallels(9000)$$);
-- (applied as 20000; re-sized to 9000 with cron.alter_job after the first measured tick — jobid 447)
