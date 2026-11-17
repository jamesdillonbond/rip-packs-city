-- anon-exec: intentional — new SECURITY DEFINER pipeline function; REVOKEd from PUBLIC/anon/authenticated below, service_role + pg_cron only (topshot_resolve_unmapped_via_atlas)
-- audit_20260908: parked Top Shot sales get their nft -> edition mapping from the Atlas firehose, so the
-- hourly promoter (jobid 474) can promote them with their on-chain price and tx hash.
--
-- WHY. `83820bd8` (2026-09-07) parks Top Shot sales whose nft has no edition mapping in
-- `unmapped_sales` and drains them hourly through `promote_unmapped_sales`. The promoter resolves an
-- nft through `nft_edition_map`, a `resolution_hint` edition / set+play, or `wallet_moments_cache` —
-- and NOTHING feeds `nft_edition_map` for Top Shot any more: its writer was the GraphQL ingest (dead
-- since ~08-28, GHA step retired 2026-09-07); 0 Top Shot rows were written in the 24 h to 09-08 14:10Z.
-- The only other exit for a parked row is `sync_sales_from_atlas` marking it resolved onto the Atlas
-- listing sale (20260908030456) — which only happens when the sale was an Atlas LISTING purchase that
-- the firehose later re-sees as completed. Measured 2026-09-08 14:10Z, 12 h after parking began:
--   355 open parked rows (all `source = 'onchain'`, marketplace `topshot`, tx hash + price present)
--   69 of them older than 4 h — i.e. past the Atlas lane's ~3 h reach — 2 with a completed event,
--   337 of the 355 have an Atlas event naming the nft's edition + serial (any kind, any state),
--   0 are in nft_edition_map, 0 in wallet_moments_cache, 0 carry a set/play hint.
-- So ~140 sales/day with a real price and tx hash would sit in `unmapped_sales` for good, and every
-- one of them is a Top Shot FMV input (M1 counts sales per edition per 30 days).
--
-- WHAT. Leg 1 of `allday_resolve_unmapped_via_atlas` (jobid 464), ported to Top Shot: for every OPEN
-- parked Top Shot nft the firehose has seen, take its newest event, resolve the event's
-- `atlas_edition_id` through `topshot_atlas_edition_map` (the same map `sync_sales_from_atlas` uses)
-- to a CANONICAL edition, and write the (nft, edition, serial) mapping via `upsert_nft_edition_map_batch`.
-- Only nfts with NO mapping are touched (never overwrites an existing row). No probe leg: the 18 nfts
-- nothing has seen wait for the firehose (the Atlas host is WAF-challenged; a probe lane is a
-- separate decision — see the residue in the ledger).
--
-- DUPLICATES (the #67 falsifier): after this, the sequence for a listing sale is parked (minutes) ->
-- mapped (:50) -> PROMOTED with tx hash (:54) -> the Atlas lane reaches the event ~3 h after the sale
-- and its nft ±10 min dedupe against `sales` finds the promoted row and skips. If the Atlas lane
-- gets there first (sale just before :50), it marks the parked row resolved (20260908030456) and the
-- promoter never sees it. Both orders are covered by guards that already exist; this adds none.
--
-- CADENCE: hourly at :50 (free minute), 4 min ahead of the promoter at :54, so a parked sale is in
-- `sales` within ~1 h instead of ~3 h (listing sales) or never (everything else).
--
-- REVERT (a stranger can run this):
--   SELECT cron.unschedule('rpc-topshot-unmapped-atlas-resolver');
--   DROP FUNCTION public.topshot_resolve_unmapped_via_atlas();
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'topshot-unmapped-atlas-resolver';
-- Mappings it wrote are correct facts about immutable nfts and can stay; to find them:
--   SELECT * FROM public.nft_edition_map WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND created_at >= '2026-09-08 14:00Z';

CREATE OR REPLACE FUNCTION public.topshot_resolve_unmapped_via_atlas()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_ts        constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_rows      jsonb;
  v_cand      int := 0;
  v_mapped    int := 0;
  v_open      int := 0;
  v_unseen    int := 0;
  v_err       text;
BEGIN
  PERFORM set_config('statement_timeout', '60000', true);

  IF NOT pg_try_advisory_xact_lock(hashtext('topshot_resolve_unmapped_via_atlas')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  BEGIN
    -- Every OPEN parked Top Shot nft the firehose has seen with a canonical edition and a real serial.
    SELECT count(*), jsonb_agg(jsonb_build_object('nft_id', x.nft_id, 'edition_external_id', x.external_id, 'serial_number', x.serial_number))
      INTO v_cand, v_rows
      FROM (
        SELECT DISTINCT ON (ev.nft_id) ev.nft_id, e.external_id, ev.serial_number
          FROM public.topshot_atlas_market_events ev
          JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
          JOIN public.editions e ON e.id = m.rpc_edition_id AND e.collection_id = v_ts
         WHERE ev.product = 'nba'
           AND ev.nft_id ~ '^[0-9]+$'
           AND ev.serial_number > 0
           AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
           AND EXISTS (SELECT 1 FROM public.unmapped_sales us
                        WHERE us.collection_id = v_ts AND us.resolved_at IS NULL AND us.nft_id = ev.nft_id)
           AND NOT EXISTS (SELECT 1 FROM public.nft_edition_map nem
                            WHERE nem.collection_id = v_ts AND nem.nft_id = ev.nft_id)
         ORDER BY ev.nft_id, ev.last_seen_at DESC
      ) x;

    IF v_rows IS NOT NULL THEN
      v_mapped := public.upsert_nft_edition_map_batch(v_ts, v_rows);
    END IF;

    SELECT count(*),
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev
                                                WHERE ev.product = 'nba' AND ev.nft_id = us.nft_id))
      INTO v_open, v_unseen
      FROM public.unmapped_sales us
     WHERE us.collection_id = v_ts AND us.resolved_at IS NULL;
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run(
    'topshot-unmapped-atlas-resolver', v_started, v_cand, v_mapped, 0,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('mapped_from_events', v_mapped, 'candidates', v_cand,
                       'open_unresolved', v_open, 'open_unseen_by_firehose', v_unseen, 'via', 'pg_cron',
                       'note', 'mapped rows are promoted into sales by promote_unmapped_sales (jobid 474, :54)',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('mapped_from_events', v_mapped, 'candidates', v_cand,
                            'open_unresolved', v_open, 'open_unseen_by_firehose', v_unseen, 'error', v_err);
END $$;

REVOKE ALL ON FUNCTION public.topshot_resolve_unmapped_via_atlas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_resolve_unmapped_via_atlas() TO service_role;

-- Minute 50 is unused by any hourly job (free-set read from cron.job 2026-09-08 14:1xZ); the promoter
-- for this collection (jobid 474) runs at :54.
SELECT cron.schedule('rpc-topshot-unmapped-atlas-resolver', '50 * * * *',
  $cron$ SELECT public.topshot_resolve_unmapped_via_atlas() $cron$);

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, is_active, notes)
VALUES ('topshot-unmapped-atlas-resolver', 180, 360, 'info', true,
        'pg_cron rpc-topshot-unmapped-atlas-resolver hourly at :50 since 2026-09-08 (migration audit_20260908_topshot_unmapped_atlas_resolver): writes nft_edition_map rows for OPEN parked Top Shot sales from topshot_atlas_market_events (newest event per nft, edition via topshot_atlas_edition_map, canonical editions only, never overwrites). rows_written = mapped_from_events (0 is normal when nothing new is parked). Watch extra.open_unseen_by_firehose — rows the firehose never named; if it climbs, a probe lane (the All Day leg 2) is the next decision.')
ON CONFLICT (pipeline) DO NOTHING;
