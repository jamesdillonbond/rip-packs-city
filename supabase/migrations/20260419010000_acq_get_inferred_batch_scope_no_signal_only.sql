-- Scope acq_get_inferred_batch to inferred_no_signal only.
--
-- Previously the RPC's WHERE clause included both inferred_no_signal and
-- inferred_pre_flowty, ordered by acquired_date ASC. That caused the
-- ts-acquisition-verifier drain to hit pre-2023 pre-Flowty-retention rows
-- first — rows that are overwhelmingly pack pulls and explicitly out of scope.
-- This migration narrows the filter to inferred_no_signal only. Signature and
-- output shape (including the total_inferred / batch_size / offset / acquisitions
-- wrapper) are preserved. The companion RPC acq_verify_from_chain already
-- refuses to overwrite any row outside the inferred buckets, so even with the
-- tighter filter the safety posture is unchanged.

CREATE OR REPLACE FUNCTION public.acq_get_inferred_batch(
  p_wallet text DEFAULT '0xbd94cade097e50ac'::text,
  p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT json_build_object(
    'total_inferred', (
      SELECT count(*) FROM moment_acquisitions
      WHERE wallet = p_wallet
        AND collection_id = p_collection_id
        AND acquisition_confidence = 'inferred_no_signal'
    ),
    'batch_size', p_limit,
    'offset', p_offset,
    'acquisitions', COALESCE((
      SELECT json_agg(row_to_json(sub))
      FROM (
        SELECT
          ma.id,
          ma.nft_id,
          ma.wallet,
          ma.transaction_hash,
          ma.acquired_date,
          ma.acquisition_method AS current_method,
          ma.acquisition_confidence AS current_confidence,
          wmc.player_name,
          wmc.set_name,
          wmc.tier,
          wmc.serial_number
        FROM moment_acquisitions ma
        LEFT JOIN wallet_moments_cache wmc
          ON wmc.moment_id = ma.nft_id
          AND wmc.wallet_address = ma.wallet
        WHERE ma.wallet = p_wallet
          AND ma.collection_id = p_collection_id
          AND ma.acquisition_confidence = 'inferred_no_signal'
          AND ma.transaction_hash IS NOT NULL
          AND ma.transaction_hash != ''
        ORDER BY ma.acquired_date ASC
        LIMIT p_limit
        OFFSET p_offset
      ) sub
    ), '[]'::json)
  );
$function$;
