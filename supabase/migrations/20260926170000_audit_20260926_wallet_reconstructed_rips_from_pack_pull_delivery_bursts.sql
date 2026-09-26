-- 2026-09-26 (PT) — the Top Shot packs a wallet opened WITHOUT a pack NFT,
-- reconstructed from the moment deliveries they produced.
--
-- WHY (Trevor: "I have definitely ripped more than 119 packs"). Dapper's pack
-- index lists 119 Top Shot packs 0xbd94cade097e50ac opened, all PackNFTs from
-- 2023-12 on. But moment_acquisitions holds 6,996 Top Shot moments that reached
-- the wallet as PACK PULLS since 2021-03 -- a pack bought and opened inside the
-- Top Shot account (a custodial pack, never minted as a PackNFT) delivers its
-- moments with no pack NFT at all, so no pack index, no on-chain pack event and
-- no rip row ever names it.
--
-- WHAT A RIP LOOKS LIKE IN THE DELIVERIES. The moments one reveal delivers land
-- within milliseconds of each other; the next reveal lands tens of seconds
-- later. Grouping the wallet's pack-pull deliveries on a gap > 3 s gives 2,851
-- bursts. ⭐ VALIDATED against the only ground truth there is: of the 115 bursts
-- that contain a moment Dapper's pull list (pack_open_pulls) attributes to one
-- of the wallet's PackNFTs, 114 reproduce that pack's moment list EXACTLY.
-- Every burst that overlaps a known PackNFT rip (or an on-chain rip ingest,
-- source 'flowty_ingest') is excluded here -- those are already rows -- which
-- leaves ~2,736 reveals the history never showed.
--
-- WHAT IT IS NOT. A reconstruction, and labelled one everywhere it surfaces
-- (rip_source = 'reconstructed'): no distribution, no pack name, no price paid,
-- and the burst rule can in principle merge two reveals seconds apart or read a
-- reward drop that the classifier labelled pack_pull as a rip. Coverage ends
-- where moment_acquisitions' pack-pull seed ends (bulk_seed / LiveToken, last
-- rows 2026-03); later custodial rips are not visible to this source.
--
-- Pull value: current FMV (latest fmv_snapshots row, > 0) of the burst's
-- moments, editions from `moments` / wallet_moments_cache, collection-scoped;
-- NULL unless every moment is priced (CHECK).
--
-- rebuild_wallet_reconstructed_rips(wallet) writes first (upsert) and then
-- deletes only this wallet's rows it did not write; rebuild_saved_wallet_
-- reconstructed_rips() runs it for every saved Flow wallet, daily 03:37.
--
-- Revert:
--   SELECT cron.unschedule('rpc-wallet-reconstructed-rips');
--   DROP FUNCTION public.rebuild_saved_wallet_reconstructed_rips();
--   DROP FUNCTION public.rebuild_wallet_reconstructed_rips(text);
--   DROP TABLE public.wallet_reconstructed_rips;
--   (revert the reader migration 20260926170100 first.)

CREATE TABLE IF NOT EXISTS public.wallet_reconstructed_rips (
  wallet          text        NOT NULL,
  collection_id   uuid        NOT NULL REFERENCES public.collections(id),
  burst_id        text        NOT NULL,
  opened_at       timestamptz NOT NULL,
  moments_pulled  int         NOT NULL,
  nft_ids         text[]      NOT NULL,
  n_resolved      int         NOT NULL,
  n_priced        int         NOT NULL,
  pull_value_usd  numeric(14,2),
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, collection_id, burst_id),
  CONSTRAINT wallet_reconstructed_rips_whole_pack CHECK (pull_value_usd IS NULL OR n_priced = moments_pulled)
);
COMMENT ON TABLE public.wallet_reconstructed_rips IS
  'Packs a wallet opened with no pack NFT (custodial Top Shot packs), reconstructed from pack-pull delivery bursts in moment_acquisitions (gap > 3 s = new reveal; 114 of 115 bursts overlapping a known PackNFT rip matched its moment list exactly). A reconstruction: no dist, no price paid. Written by rebuild_wallet_reconstructed_rips().';
ALTER TABLE public.wallet_reconstructed_rips ENABLE ROW LEVEL SECURITY;
-- the rebuild asks "is any of this burst's moments in a known pack's pull list"
CREATE INDEX IF NOT EXISTS idx_pack_open_pulls_nft ON public.pack_open_pulls (collection_id, nft_id);
REVOKE ALL ON public.wallet_reconstructed_rips FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.rebuild_wallet_reconstructed_rips(p_wallet text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_wallet text := lower(trim(coalesce(p_wallet, '')));
  v_started timestamptz := clock_timestamp();
  v_written int := 0;
  v_deleted int := 0;
  v_valued int := 0;
BEGIN
  IF v_wallet = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wallet required');
  END IF;

  WITH pulls AS (
    -- one delivery per moment: its earliest pack-pull row for this wallet
    SELECT DISTINCT ON (ma.collection_id, ma.nft_id) ma.collection_id, ma.nft_id, ma.acquired_date
    FROM public.moment_acquisitions ma
    WHERE ma.wallet = v_wallet
      AND ma.acquisition_method = 'pack_pull'
      AND ma.acquired_date IS NOT NULL
      AND ma.collection_id IS NOT NULL
    ORDER BY ma.collection_id, ma.nft_id, ma.acquired_date
  ), gapped AS (
    SELECT p.*,
           p.acquired_date - lag(p.acquired_date) OVER (PARTITION BY p.collection_id ORDER BY p.acquired_date, p.nft_id) AS gap
    FROM pulls p
  ), numbered AS (
    SELECT g.*,
           sum(CASE WHEN g.gap IS NULL OR g.gap > interval '3 seconds' THEN 1 ELSE 0 END)
             OVER (PARTITION BY g.collection_id ORDER BY g.acquired_date, g.nft_id) AS burst
    FROM gapped g
  ), bursts AS (
    SELECT n.collection_id, n.burst,
           min(n.acquired_date) AS opened_at,
           array_agg(n.nft_id ORDER BY n.acquired_date, n.nft_id) AS nft_ids
    FROM numbered n
    GROUP BY n.collection_id, n.burst
  ), fresh AS (
    -- not already a row: no moment of the burst is in a known pack's pull list,
    -- and none arrived through the on-chain rip ingest
    SELECT b.*
    FROM bursts b
    WHERE NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o
                       WHERE o.collection_id = b.collection_id AND o.nft_id = ANY (b.nft_ids))
      AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions m2
                       WHERE m2.wallet = v_wallet AND m2.collection_id = b.collection_id
                         AND m2.nft_id = ANY (b.nft_ids) AND m2.source = 'flowty_ingest')
  ), priced AS (
    SELECT f.collection_id, f.opened_at, f.nft_ids,
           f.nft_ids[1] AS first_nft,
           cardinality(f.nft_ids) AS n_pulls,
           count(ed.edition_id) AS n_resolved,
           count(fv.fmv_usd) AS n_priced,
           sum(fv.fmv_usd) AS total
    FROM fresh f
    CROSS JOIN LATERAL unnest(f.nft_ids) AS u(nft_id)
    LEFT JOIN LATERAL (
      SELECT coalesce(
        (SELECT mo.edition_id FROM public.moments mo
          WHERE mo.nft_id = u.nft_id AND mo.collection_id = f.collection_id AND mo.edition_id IS NOT NULL LIMIT 1),
        (SELECT e.id FROM public.wallet_moments_cache w
           JOIN public.editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
          WHERE w.moment_id = u.nft_id AND w.collection_id = f.collection_id AND w.edition_key IS NOT NULL LIMIT 1)
      ) AS edition_id
    ) ed ON true
    LEFT JOIN LATERAL (
      SELECT CASE WHEN s.fmv_usd > 0 THEN s.fmv_usd END AS fmv_usd
      FROM public.fmv_snapshots s
      WHERE ed.edition_id IS NOT NULL
        AND s.collection_id = f.collection_id AND s.edition_id = ed.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fv ON true
    GROUP BY f.collection_id, f.opened_at, f.nft_ids
  ), ins AS (
    INSERT INTO public.wallet_reconstructed_rips
      (wallet, collection_id, burst_id, opened_at, moments_pulled, nft_ids, n_resolved, n_priced, pull_value_usd, computed_at)
    SELECT v_wallet, p.collection_id, 'burst:' || p.first_nft, p.opened_at, p.n_pulls, p.nft_ids,
           p.n_resolved, p.n_priced,
           CASE WHEN p.n_priced = p.n_pulls THEN round(p.total, 2) END,
           v_started
    FROM priced p
    ON CONFLICT (wallet, collection_id, burst_id) DO UPDATE
      SET opened_at = EXCLUDED.opened_at, moments_pulled = EXCLUDED.moments_pulled,
          nft_ids = EXCLUDED.nft_ids, n_resolved = EXCLUDED.n_resolved, n_priced = EXCLUDED.n_priced,
          pull_value_usd = EXCLUDED.pull_value_usd, computed_at = EXCLUDED.computed_at
    RETURNING pull_value_usd
  )
  SELECT count(*), count(pull_value_usd) INTO v_written, v_valued FROM ins;

  -- write first, then delete only this wallet's rows this run did not write
  DELETE FROM public.wallet_reconstructed_rips
   WHERE wallet = v_wallet AND computed_at < v_started;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'wallet', v_wallet, 'reconstructed', v_written,
                            'valued', v_valued, 'retired', v_deleted);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rebuild_saved_wallet_reconstructed_rips()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  w record;
  v_res jsonb;
  v_wallets int := 0;
  v_rows int := 0;
  v_valued int := 0;
BEGIN
  FOR w IN
    SELECT DISTINCT lower(trim(wallet_addr)) AS wallet FROM public.saved_wallets
     WHERE lower(trim(wallet_addr)) ~ '^0x[0-9a-f]{16}$'
     ORDER BY 1
  LOOP
    v_res := public.rebuild_wallet_reconstructed_rips(w.wallet);
    v_wallets := v_wallets + 1;
    v_rows := v_rows + coalesce((v_res->>'reconstructed')::int, 0);
    v_valued := v_valued + coalesce((v_res->>'valued')::int, 0);
  END LOOP;

  PERFORM public.log_pipeline_run(
    'wallet-reconstructed-rips', v_started, v_wallets, v_rows, 0, true, NULL, NULL, NULL, NULL,
    jsonb_build_object('wallets', v_wallets, 'reconstructed', v_rows, 'valued', v_valued));

  RETURN jsonb_build_object('ok', true, 'wallets', v_wallets, 'reconstructed', v_rows, 'valued', v_valued);
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_wallet_reconstructed_rips(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebuild_saved_wallet_reconstructed_rips() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_wallet_reconstructed_rips(text) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_saved_wallet_reconstructed_rips() TO postgres, service_role;

SELECT cron.schedule('rpc-wallet-reconstructed-rips', '37 10 * * *', 'SELECT public.rebuild_saved_wallet_reconstructed_rips();');
