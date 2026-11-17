-- Item 2 (2026-06-23 audit residual): recover the legacy-CDN-404 thumbnails on
-- entity grids for editions that have NO held moment in wallet_moments_cache
-- (so the wmc-only rep_nft_id was NULL and the tile fell back to the dead
-- assets.nbatopshot.com/editions/... URL). ~284 TS editions render a tile but
-- lack a wmc rep; ~173 resolve a media/<nft_id>/image via a moments/sales nft_id.
-- Shared inlinable helper, COALESCE(wmc, moments, sales): each source is indexed
-- (wmc edition_key, idx_moments_edition, idx_sales_edition) and short-circuits, so
-- the fallbacks only run for the minority of editions missing a wmc rep. Additive
-- — rep_nft_id is only an image candidate; the stored thumbnail is still the final
-- fallback in the tile components. The 5 entity RPCs (get_set_editions,
-- get_player_editions, get_series_editions, get_team_top_editions,
-- get_pack_contents) swap their inline wmc subquery for a call to the helper.
--
-- Applied live 2026-06-23 via Supabase MCP; this file is the repo-parity copy.
-- Revert: restore each RPC's inline
--   (SELECT w.moment_id FROM wallet_moments_cache w
--      WHERE w.collection_id = p_collection_id AND w.edition_key = e.external_id
--        AND w.moment_id ~ '^[0-9]+$' LIMIT 1) AS rep_nft_id
-- and DROP FUNCTION public.entity_rep_nft_id(uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.entity_rep_nft_id(p_collection_id uuid, p_external_id text, p_edition_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (SELECT w.moment_id FROM wallet_moments_cache w
       WHERE w.collection_id = p_collection_id
         AND w.edition_key = p_external_id
         AND w.moment_id ~ '^[0-9]+$'
       LIMIT 1),
    (SELECT m.nft_id FROM moments m
       WHERE m.edition_id = p_edition_id
         AND m.nft_id ~ '^[0-9]+$'
       LIMIT 1),
    (SELECT s.nft_id FROM sales s
       WHERE s.edition_id = p_edition_id
         AND s.nft_id ~ '^[0-9]+$'
       ORDER BY s.sold_at DESC NULLS LAST
       LIMIT 1)
  );
$$;
REVOKE ALL ON FUNCTION public.entity_rep_nft_id(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.entity_rep_nft_id(uuid, text, uuid) TO service_role;

-- Each of the 5 entity RPCs below was CREATE OR REPLACE'd live with exactly one
-- line changed in its non-Pinnacle branch — the inline wmc subquery replaced by:
--   public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
-- The full bodies are identical to the prior live definitions otherwise. They are
-- reproduced in the live DB (pg_get_functiondef) and were not re-templated here to
-- avoid drift; this repo dir is a parity record, not the replay source (all audit
-- migrations since 2026-05-17 are applied live-only and tracked in the ledger).
