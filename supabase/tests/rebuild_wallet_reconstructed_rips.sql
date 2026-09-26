-- DB invariant: public.rebuild_wallet_reconstructed_rips — reconstructs the
-- packs a wallet opened with NO pack NFT (custodial Top Shot packs) from its
-- pack-pull delivery bursts. Added 2026-09-26 ("I have definitely ripped more
-- than 119 packs" -- Trevor). Claims it must keep:
--
--   1. A burst is deliveries <= 3 s apart; a gap > 3 s starts a new reveal.
--   2. A burst that overlaps a KNOWN rip -- any moment in a PackNFT's pull list
--      (pack_open_pulls) or delivered through the on-chain rip ingest
--      (source 'flowty_ingest') -- is NOT reconstructed: it is already a row.
--   3. Whole-pack, all-or-nothing: pull_value_usd only when every moment is
--      priced (FMV > 0); editions collection-scoped, latest snapshot wins.
--   4. Idempotent, and a rebuild RETIRES a burst that is no longer one (write
--      first, delete only what this run did not write) -- for this wallet only.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926170000_audit_20260926_wallet_reconstructed_rips_from_pack_pull_delivery_bursts.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text UNIQUE, name text);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.moments (nft_id text, collection_id uuid, edition_id uuid);
CREATE TABLE public.wallet_moments_cache (wallet_address text, moment_id text, collection_id uuid, edition_key text);
CREATE TABLE public.fmv_snapshots (collection_id uuid, edition_id uuid, fmv_usd numeric, computed_at timestamptz);
CREATE TABLE public.moment_acquisitions (wallet text, collection_id uuid, nft_id text, acquired_date timestamptz, acquisition_method text, source text);
CREATE TABLE public.pack_open_pulls (collection_id uuid, pack_nft_id text, nft_id text);
CREATE TABLE public.wallet_reconstructed_rips (
  wallet text NOT NULL, collection_id uuid NOT NULL, burst_id text NOT NULL, opened_at timestamptz NOT NULL,
  moments_pulled int NOT NULL, nft_ids text[] NOT NULL, n_resolved int NOT NULL, n_priced int NOT NULL,
  pull_value_usd numeric(14,2), computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, collection_id, burst_id),
  CONSTRAINT wallet_reconstructed_rips_whole_pack CHECK (pull_value_usd IS NULL OR n_priced = moments_pulled));

-- >>> BEGIN verbatim rebuild_wallet_reconstructed_rips (body byte-identical to the migration) >>>
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
-- <<< END verbatim <<<

INSERT INTO public.collections VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', 'NBA Top Shot'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day', 'NFL All Day');
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000a1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1'),
  ('00000000-0000-0000-0000-0000000000a2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2'),
  ('00000000-0000-0000-0000-0000000000a3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:3'),
  ('00000000-0000-0000-0000-0000000000a9', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '9:9');
-- moment editions: 1,2 via moments; 3 via wmc; 5 via wmc edition with FMV 0;
-- 9 has an All Day moments row only (must NOT name the Top Shot 9).
INSERT INTO public.moments VALUES
  ('1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a1'),
  ('2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a2'),
  ('9', 'dee28451-5d62-409e-a1ad-a83f763ac070', '00000000-0000-0000-0000-0000000000a9');
INSERT INTO public.wallet_moments_cache VALUES
  ('0xother', '3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:3'),
  ('0xother', '5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '9:9');
INSERT INTO public.fmv_snapshots VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a1', 1, '2026-01-01'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a1', 4, '2026-09-01'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a2', 2.5, '2026-09-01'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a3', 3, '2026-09-01'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a9', 0, '2026-09-01');
-- Deliveries for 0xw:
--   burst A: 1, 2, 3 within 5 ms                         -> priced 4 + 2.5 + 3 = 9.50
--   burst B: 4 alone, 30 s later (no edition)            -> unpriced
--   burst C: 5 + 9, 1 s apart (5 FMV 0, 9 unresolvable)   -> unpriced, n_priced 0
--   burst D: 6, 7 -- 7 is in a KNOWN PackNFT pull list   -> excluded
--   burst E: 8 -- delivered by the on-chain rip ingest   -> excluded
--   a marketplace buy (not pack_pull) inside burst A's second -> ignored
INSERT INTO public.moment_acquisitions VALUES
  ('0xw', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1', '2024-05-01 10:00:00.001', 'pack_pull', 'bulk_seed'),
  ('0xw', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '2', '2024-05-01 10:00:00.003', 'pack_pull', 'bulk_seed'),
  ('0xw', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '3', '2024-05-01 10:00:00.005', 'pack_pull', 'livetoken_activity'),
  ('0xw', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '99', '2024-05-01 10:00:00.004', 'marketplace', 'bulk_seed'),
  ('0xw', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '4', '2024-05-01 10:00:30', 'pack_pull', 'bulk_seed'),
  ('0xw', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '5', '2024-05-01 10:01:00', 'pack_pull', 'bulk_seed'),
  ('0xw', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '9', '2024-05-01 10:01:01', 'pack_pull', 'bulk_seed'),
  ('0xw', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '6', '2024-05-01 10:02:00', 'pack_pull', 'bulk_seed'),
  ('0xw', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '7', '2024-05-01 10:02:00.2', 'pack_pull', 'bulk_seed'),
  ('0xw', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '8', '2024-05-01 10:03:00', 'pack_pull', 'flowty_ingest'),
  -- another wallet's burst, which a rebuild of 0xw must never touch
  ('0xv', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '50', '2024-05-01 10:00:00', 'pack_pull', 'bulk_seed');
INSERT INTO public.pack_open_pulls VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK1', '7');

DO $$
DECLARE v jsonb; n int;
BEGIN
  PERFORM public.rebuild_wallet_reconstructed_rips('0xv');
  v := public.rebuild_wallet_reconstructed_rips('0xW');
  PERFORM _assert_eq(v->>'reconstructed', '3', 'bursts A, B, C; D and E are already rips');
  PERFORM _assert_eq(v->>'valued', '1', 'only A is fully priced');
  PERFORM _assert_eq((SELECT array_to_string(nft_ids, ',') FROM public.wallet_reconstructed_rips WHERE wallet = '0xw' AND burst_id = 'burst:1'),
                     '1,2,3', 'A: deliveries 2 ms apart are one reveal; the marketplace buy is not a pull');
  PERFORM _assert_eq((SELECT pull_value_usd::text FROM public.wallet_reconstructed_rips WHERE burst_id = 'burst:1'), '9.50',
                     'A = latest FMV 4 (not the older 1) + 2.5 + 3');
  PERFORM _assert((SELECT moments_pulled = 1 AND pull_value_usd IS NULL AND n_resolved = 0 FROM public.wallet_reconstructed_rips WHERE burst_id = 'burst:4'),
                  'B: a 30 s gap is a new reveal; no edition -> NULL, never $0');
  PERFORM _assert((SELECT moments_pulled = 2 AND n_resolved = 1 AND n_priced = 0 AND pull_value_usd IS NULL
                     FROM public.wallet_reconstructed_rips WHERE burst_id = 'burst:5'),
                  'C: FMV 0 is unpriced, and an All Day moments row never names a Top Shot moment');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.wallet_reconstructed_rips WHERE '7' = ANY (nft_ids) OR '6' = ANY (nft_ids)),
                  'D: a burst overlapping a known PackNFT pull list is not reconstructed');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.wallet_reconstructed_rips WHERE '8' = ANY (nft_ids)),
                  'E: a burst the on-chain rip ingest delivered is not reconstructed');

  -- idempotent
  v := public.rebuild_wallet_reconstructed_rips('0xw');
  SELECT count(*) INTO n FROM public.wallet_reconstructed_rips WHERE wallet = '0xw';
  PERFORM _assert_eq(n::text, '3', 'a second rebuild writes the same three rows');

  -- burst B is now known to be part of a PackNFT -> retired; 0xv untouched
  INSERT INTO public.pack_open_pulls VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK2', '4');
  v := public.rebuild_wallet_reconstructed_rips('0xw');
  PERFORM _assert_eq(v->>'retired', '1', 'B retired once a known rip covers it');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.wallet_reconstructed_rips WHERE burst_id = 'burst:4'), 'B gone');
  PERFORM _assert((SELECT count(*) = 1 FROM public.wallet_reconstructed_rips WHERE wallet = '0xv'), 'another wallet''s rows survive');
  PERFORM _assert((public.rebuild_wallet_reconstructed_rips(''))->>'ok' = 'false', 'empty wallet refused');
END $$;

ROLLBACK;
