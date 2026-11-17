-- Move pg_trgm from public schema to extensions schema.
-- Requires the extensions schema to exist (it does in all Supabase projects).
-- Apply this migration via Supabase dashboard or MCP, not from application code.

DROP EXTENSION IF EXISTS pg_trgm CASCADE;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
