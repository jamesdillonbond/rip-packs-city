-- Removes the INVALID leftover index left by a CREATE INDEX CONCURRENTLY that
-- the Supabase MCP's 60 s client cap cut off mid-build (indisready=true,
-- indisvalid=false). An invalid-but-ready index is never used by the planner
-- yet is still maintained on every INSERT/UPDATE to pack_rips, so it is pure
-- write cost. Dropping restores the pre-session state exactly.
-- Revert: none needed (this returns pack_rips to its 2026-08-13 index set).
DROP INDEX IF EXISTS public.idx_pack_rips_collection_block_height;
