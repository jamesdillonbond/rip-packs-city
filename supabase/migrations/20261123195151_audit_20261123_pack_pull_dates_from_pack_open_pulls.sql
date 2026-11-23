-- audit_20261123_pack_pull_dates_from_pack_open_pulls
--
-- 2026-11-23 (Claude Code cloud; Trevor: "Keep working through all you can and try to resolve these still open").
-- known-issues #261: "~11.4k pack pulls undated (All Day proven only via pack_open_pulls, which has no time column)".
--
-- WHY. pack_pull_open_time() dates a pack-pull acquisition from ONE source per collection (Top Shot:
-- topshot_arrival_provenance kind P; All Day: allday_pack_pull). A pull proven only by pack_open_pulls (the
-- pack -> moment map) got no date, and the register filed the remainder as needing Dune chain history. It does
-- not: pack_open_pulls.pack_nft_id joins pack_rips, whose sealed_at is the open-event block time. Measured
-- 2026-11-23 ~11:50 AM PT against the independent All Day source: over 1,487,682 packs present in both,
-- pack_rips.sealed_at = allday_pack_pull.sealed_at for every one (median |diff| 0 s).
--
-- Population (acquisition_method = 'pack_pull', acquired_date NULL): Top Shot 1,746, All Day 11,255. The new arm
-- requires the pack's OPENER to be exactly the acquiring wallet (a moment someone else pulled is not this
-- wallet's pull) and exactly ONE distinct open time; under that rule 1,746 + 11,230 date, and 25 All Day rows
-- (several rips / another opener) stay NULL. 0 rows date later than the row was created.
--
-- WHAT. pack_pull_open_time(): the Top Shot and All Day arms become COALESCE(existing source, the new arm), so an
-- existing date never changes and the new arm only fills a gap. Golazos / Pinnacle arms byte-identical. Base =
-- live prosrc md5 411a98832e1ad195c906b066e10dcb8b (read immediately before). The insert trigger
-- trg_moment_acq_pack_pull_date calls this function, so new pulls proven this way are dated at insert too.
-- Then backfill_pack_pull_dates() (unchanged, records every write in flowty_archive.acq_pack_pull_date_20261117).
-- Index-backed: pack_open_pulls (collection_id, nft_id) = idx_pack_open_pulls_nft; pack_rips (pack_nft_id) unique.
--
-- anon-exec: revoked (pack_pull_open_time) — unchanged grant; service_role only.
--
-- REVERT: UPDATE moment_acquisitions m SET acquired_date = NULL FROM flowty_archive.acq_pack_pull_date_20261117 r
--   WHERE m.id = r.acq_id AND r.written_at >= '2026-11-23 19:50:00+00';  (this run only: 12,976 rows written 11:52 AM PT; the 11-17 rows are older)
--   then re-apply 20261117173000 for the previous pack_pull_open_time body.

CREATE OR REPLACE FUNCTION public.pack_pull_open_time(p_collection_id uuid, p_wallet text, p_nft_id text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE p_collection_id
    WHEN '95f28a17-224a-4025-96ad-adf8a4c63bfd' THEN
      COALESCE(
        (SELECT max(p.arrival_date)::timestamptz FROM topshot_arrival_provenance p
          WHERE p.wallet = p_wallet AND p.nft_id = p_nft_id AND p.kind = 'P'),
        -- 2026-11-23: pack_open_pulls -> pack_rips.sealed_at (open-event block time), opener = the wallet,
        -- exactly one distinct open time.
        (SELECT CASE WHEN count(DISTINCT r.sealed_at) = 1 THEN max(r.sealed_at) END
           FROM pack_open_pulls po JOIN pack_rips r ON r.pack_nft_id = po.pack_nft_id AND r.collection_id = po.collection_id
          WHERE po.collection_id = p_collection_id AND po.nft_id = p_nft_id
            AND r.opener_address = p_wallet AND r.sealed_at IS NOT NULL))
    WHEN '06248cc4-b85f-47cd-af67-1855d14acd75' THEN
      (SELECT go.opened_at FROM golazos_pack_open_pulls gp JOIN golazos_pack_opens go ON go.pack_nft_id = gp.pack_nft_id
        WHERE gp.nft_id = p_nft_id AND go.opener_address = p_wallet)
    WHEN '7dd9dd11-e8b6-45c4-ac99-71331f959714' THEN
      (SELECT max(po.opened_at) FROM pinnacle_pack_opens po
        WHERE po.opener_address = p_wallet AND p_nft_id = ANY (po.nft_ids))
    -- All Day: sealed_at is the block_timestamp of the block holding the PackNFT open event
    -- (supabase/functions/ingest-allday-pack-opens: `sealed_at: blk.block_timestamp`).
    WHEN 'dee28451-5d62-409e-a1ad-a83f763ac070' THEN
      COALESCE(
        (SELECT max(a.sealed_at) FROM allday_pack_pull a
          WHERE a.moment_nft_id = p_nft_id AND a.opener_address = p_wallet),
        -- 2026-11-23: same fallback as Top Shot (pack_rips.sealed_at = allday_pack_pull.sealed_at on 1.49M packs).
        (SELECT CASE WHEN count(DISTINCT r.sealed_at) = 1 THEN max(r.sealed_at) END
           FROM pack_open_pulls po JOIN pack_rips r ON r.pack_nft_id = po.pack_nft_id AND r.collection_id = po.collection_id
          WHERE po.collection_id = p_collection_id AND po.nft_id = p_nft_id
            AND r.opener_address = p_wallet AND r.sealed_at IS NOT NULL))
  END
$fn$;

REVOKE ALL ON FUNCTION public.pack_pull_open_time(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pack_pull_open_time(uuid, text, text) TO service_role;
