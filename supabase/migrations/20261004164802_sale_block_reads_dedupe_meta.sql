-- 2026-10-04 (PT). ingest_sale_block_reads (migration 20261004161541): de-duplicate the meta rows of one call by
-- (collection code, nft id) before handing them to ingest_checkpoint_nft_meta.
--
-- Why: one page of candidates can hold two SALES of the same NFT (bought, then resold); both reads return the
-- same record, and ingest_checkpoint_nft_meta's INSERT … ON CONFLICT (c, nft_id, spork) DO UPDATE then fails with
-- "ON CONFLICT DO UPDATE command cannot affect row a second time" (Postgres log, 16:45–16:46Z 2026-10-04). The
-- reader retried each 500 and 5 of 6 shards of run 37217650506 died "unreachable after retries". An NFT's set /
-- play / serial / edition cannot differ between two of its sales, so keeping one row per (c, nft id) loses nothing.
--
-- anon-exec: unchanged (ingest_sale_block_reads) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false, service_role=true.
--
-- Revert: re-apply the function body of migration 20261004161541.

CREATE OR REPLACE FUNCTION public.ingest_sale_block_reads(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
DECLARE v_meta int := 0; v_cand int;
BEGIN
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r, jsonb_array_elements(COALESCE(r->'meta', '[]'::jsonb)) m
              WHERE m->>'c' NOT IN ('ts', 'tssub', 'ad', 'ufc')) THEN
    RAISE EXCEPTION 'meta row with an unknown collection code';
  END IF;
  SELECT public.ingest_checkpoint_nft_meta(COALESCE(jsonb_agg(d.m || jsonb_build_object('spork', 1)), '[]'::jsonb)) INTO v_meta
    FROM (SELECT DISTINCT ON (m->>'c', m->>'id') m
            FROM jsonb_array_elements(p_rows) r, jsonb_array_elements(COALESCE(r->'meta', '[]'::jsonb)) m
           ORDER BY m->>'c', m->>'id') d;
  WITH u AS (
    UPDATE flowty_archive.sale_block_read_candidates c
       SET status = CASE WHEN (r->>'found')::boolean THEN 'found' ELSE 'absent' END, read_at = now()
      FROM jsonb_array_elements(p_rows) r
     WHERE c.k = r->>'k' AND c.status IS NULL
    RETURNING 1)
  SELECT count(*) INTO v_cand FROM u;
  RETURN jsonb_build_object('meta', v_meta, 'candidates', v_cand);
END $f$;
