-- 2026-10-03 (PT) — Name NFTs minted AFTER the newest checkpoint from their MINT EVENTS.
--
-- WHY. RPC's own ingest missed ~108k Top Shot Flowty sales in Apr–May 2026 (flowty_index_sales
-- docs with no match in `sales`); ~43k of them are moments minted after 2025-12-29, which no
-- spork-root checkpoint holds (mainnet28's root IS 2025-12-29; there is no later one). The mint
-- events name them holder-independently, and the mainnet28 history node serves them. Signatures
-- read from the deployed contracts 2026-10-03 (/v1/accounts/{addr}?expand=contracts):
--   A.0b2a3299cc857e29.TopShot.MomentMinted(momentID: UInt64, playID: UInt32, setID: UInt32,
--       serialNumber: UInt32, subeditionID: UInt32)
--   A.0b2a3299cc857e29.TopShot.SubeditionAddedToMoment(momentID, subeditionID, setID, playID)
--   A.e4cf4bdc1751c65d.AllDay.MomentNFTMinted(id: UInt64, editionID: UInt64, serialNumber: UInt64)
-- Rows land in public.checkpoint_nft_meta with spork = 128 ("mainnet28 mint events"); the
-- promotion reads each NFT at its HIGHEST spork code, and these values are immutable, so a
-- moment present in both agrees by construction (checked after the load).
-- A Top Shot subedition comes from SubeditionAddedToMoment when present, else MomentMinted's
-- subeditionID; a 'tssub' row is written only for a non-zero subedition (absent = Standard, as
-- for the checkpoint rows).
-- Coverage per stream is written atomically with the rows, as for the Flowty walk.
--
-- Revert: DROP FUNCTION public.ingest_mint_walk(jsonb, jsonb, text), public.mint_walk_covered(text, bigint, bigint);
--         DROP TABLE flowty_archive.mint_walk_coverage; DELETE FROM public.checkpoint_nft_meta WHERE spork = 128;

CREATE TABLE IF NOT EXISTS flowty_archive.mint_walk_coverage (
  stream     text        NOT NULL,
  win_start  bigint      NOT NULL,
  win_end    bigint      NOT NULL,
  n_events   integer     NOT NULL,
  walked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream, win_start)
);
ALTER TABLE flowty_archive.mint_walk_coverage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flowty_archive.mint_walk_coverage FROM PUBLIC, anon, authenticated;

-- p_meta: checkpoint_nft_meta-shaped records ({c, id, set|ed|sub, play, serial}); p_windows:
-- [{win_start, win_end, n_events}]. Returns {"meta": rows upserted, "windows": windows recorded}.
CREATE OR REPLACE FUNCTION public.ingest_mint_walk(p_meta jsonb, p_windows jsonb, p_stream text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
DECLARE v_meta int := 0; v_win int;
BEGIN
  IF p_stream NOT IN ('ts_minted', 'ts_subedition', 'ad_minted') THEN
    RAISE EXCEPTION 'unknown stream %', p_stream;
  END IF;
  IF jsonb_array_length(p_meta) > 0 THEN
    v_meta := public.ingest_checkpoint_nft_meta(
      (SELECT jsonb_agg(r || jsonb_build_object('spork', 128)) FROM jsonb_array_elements(p_meta) r));
  END IF;
  WITH w AS (
    INSERT INTO flowty_archive.mint_walk_coverage (stream, win_start, win_end, n_events)
    SELECT p_stream, (x->>'win_start')::bigint, (x->>'win_end')::bigint, (x->>'n_events')::int
      FROM jsonb_array_elements(p_windows) x
    ON CONFLICT (stream, win_start) DO UPDATE SET win_end = EXCLUDED.win_end, n_events = EXCLUDED.n_events, walked_at = now()
    RETURNING 1)
  SELECT count(*) INTO v_win FROM w;
  RETURN jsonb_build_object('meta', v_meta, 'windows', v_win);
END $f$;
REVOKE ALL ON FUNCTION public.ingest_mint_walk(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_mint_walk(jsonb, jsonb, text) TO service_role;

CREATE OR REPLACE FUNCTION public.mint_walk_covered(p_stream text, p_from bigint, p_to bigint)
RETURNS bigint[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
  SELECT COALESCE(array_agg(win_start ORDER BY win_start), '{}'::bigint[])
    FROM flowty_archive.mint_walk_coverage
   WHERE stream = p_stream AND win_start BETWEEN p_from AND p_to
$f$;
REVOKE ALL ON FUNCTION public.mint_walk_covered(text, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mint_walk_covered(text, bigint, bigint) TO service_role;
