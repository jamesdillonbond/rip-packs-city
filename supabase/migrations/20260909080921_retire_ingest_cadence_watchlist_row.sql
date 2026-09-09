-- Retire the cadence-watchlist row for the decommissioned `ingest` lane so it stops
-- firing a permanent false `medium` stall. The lane was retired from rpc-pipeline.yml
-- on 2026-09-07 (ledger #67(3): upstream public-api.nbatopshot.com decommissioned 530/CF-1033;
-- sales now written by sync_sales_from_atlas). Its last run is frozen at 2026-09-07T23:46:57Z,
-- so detect_stalled_pipelines() returns it at `medium` forever and the rpc-qa-scorecard
-- "Pipelines stalled" card reads RED permanently — a stall arm that can never clear masks a
-- future real stall of a still-live lane.
-- Revert: UPDATE pipeline_cadence_watchlist SET is_active=true WHERE pipeline='ingest';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pipeline_cadence_watchlist WHERE pipeline='ingest' AND is_active=true;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 active ingest watchlist row, found %', n;
  END IF;
  UPDATE pipeline_cadence_watchlist
     SET is_active = false,
         notes = coalesce(notes,'') || ' | [2026-09-09 NIGHT PASS: is_active->false. Lane retired from rpc-pipeline.yml 2026-09-07 (upstream decommissioned; sales via sync_sales_from_atlas). Last run frozen 2026-09-07T23:46:57Z so detect_stalled_pipelines() returned it medium forever and the qa-scorecard stall card read RED permanently. Flipped inactive to mirror the lane retirement. Re-arm (is_active=true) only if an Atlas-port ingest lane lands under this name. Revert: SET is_active=true.]'
   WHERE pipeline='ingest';
END $$;