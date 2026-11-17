-- audit_20261117_pack_pull_dates_all_day
--
-- 2026-11-17 (Claude Code cloud; Trevor: "Keep going and working through those still open").
--
-- WHY. 20261117171500 dated pack-pull acquisitions for Top Shot / Golazos / Pinnacle; All Day's 16,812 were left
-- NULL because allday_pack_pull has no column named for the open time. It does have one: sealed_at is written by
-- supabase/functions/ingest-allday-pack-opens as `blk.block_timestamp` of the block holding the PackNFT open
-- event — the open time. 5,592 of the NULL All Day pulls match (moment, opener = the wallet) in allday_pack_pull;
-- the rest were proven by pack_open_pulls, which records no time, and stay NULL.
--
-- WHAT. pack_pull_open_time() gains the All Day arm; backfill_pack_pull_dates() gains All Day in its collection
-- filter. Both bodies otherwise byte-identical to 20261117171500 (verified live md5 immediately before). The
-- insert trigger calls pack_pull_open_time, so new All Day pulls are dated at insert from now on.
--
-- anon-exec: revoked (pack_pull_open_time) — unchanged grant; service_role only.
-- anon-exec: revoked (backfill_pack_pull_dates) — unchanged grant; service_role only.
--
-- REVERT: UPDATE moment_acquisitions m SET acquired_date = NULL FROM flowty_archive.acq_pack_pull_date_20261117 r
--   WHERE m.id = r.acq_id AND r.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070';
--   then re-apply 20261117171500 for the previous bodies.

CREATE OR REPLACE FUNCTION public.pack_pull_open_time(p_collection_id uuid, p_wallet text, p_nft_id text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE p_collection_id
    WHEN '95f28a17-224a-4025-96ad-adf8a4c63bfd' THEN
      (SELECT max(p.arrival_date)::timestamptz FROM topshot_arrival_provenance p
        WHERE p.wallet = p_wallet AND p.nft_id = p_nft_id AND p.kind = 'P')
    WHEN '06248cc4-b85f-47cd-af67-1855d14acd75' THEN
      (SELECT go.opened_at FROM golazos_pack_open_pulls gp JOIN golazos_pack_opens go ON go.pack_nft_id = gp.pack_nft_id
        WHERE gp.nft_id = p_nft_id AND go.opener_address = p_wallet)
    WHEN '7dd9dd11-e8b6-45c4-ac99-71331f959714' THEN
      (SELECT max(po.opened_at) FROM pinnacle_pack_opens po
        WHERE po.opener_address = p_wallet AND p_nft_id = ANY (po.nft_ids))
    -- All Day: sealed_at is the block_timestamp of the block holding the PackNFT open event
    -- (supabase/functions/ingest-allday-pack-opens: `sealed_at: blk.block_timestamp`).
    WHEN 'dee28451-5d62-409e-a1ad-a83f763ac070' THEN
      (SELECT max(a.sealed_at) FROM allday_pack_pull a
        WHERE a.moment_nft_id = p_nft_id AND a.opener_address = p_wallet)
  END
$fn$;

CREATE OR REPLACE FUNCTION public.backfill_pack_pull_dates(p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_out jsonb;
BEGIN
  WITH cand AS (
    SELECT ma.id, ma.collection_id, public.pack_pull_open_time(ma.collection_id, ma.wallet, ma.nft_id) AS d
    FROM moment_acquisitions ma
    WHERE ma.acquisition_method = 'pack_pull' AND ma.acquired_date IS NULL
      AND ma.collection_id IN ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '06248cc4-b85f-47cd-af67-1855d14acd75',
                               '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'dee28451-5d62-409e-a1ad-a83f763ac070')
      AND NOT EXISTS (SELECT 1 FROM flowty_archive.acq_pack_pull_date_20261117 r WHERE r.acq_id = ma.id)
  ), dated AS (
    SELECT * FROM cand WHERE d IS NOT NULL LIMIT p_limit
  ), upd AS (
    UPDATE moment_acquisitions m SET acquired_date = t.d
    FROM dated t WHERE m.id = t.id AND m.acquired_date IS NULL
    RETURNING m.id, m.collection_id, m.acquired_date
  ), rec AS (
    INSERT INTO flowty_archive.acq_pack_pull_date_20261117 (acq_id, collection_id, new_date)
    SELECT id, collection_id, acquired_date FROM upd
    ON CONFLICT (acq_id) DO NOTHING
    RETURNING 1
  )
  SELECT jsonb_build_object('dated', (SELECT count(*) FROM rec),
                            'undatable_remaining', (SELECT count(*) FROM cand WHERE d IS NULL))
    INTO v_out;
  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.pack_pull_open_time(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pack_pull_open_time(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.backfill_pack_pull_dates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_pack_pull_dates(integer) TO service_role;
