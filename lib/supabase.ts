import { createClient } from '@supabase/supabase-js'

/*
 * ── Sales table partitioning note ─────────────────────────────────────────
 * Sales table is year-partitioned (sales_2020–2026). DISTINCT ON is not
 * available via the JS client on partitioned tables — fetch ordered by
 * computed_at DESC and deduplicate in app code.
 * ──────────────────────────────────────────────────────────────────────────
 */

// Browser client — used in React components
// Has read-only access to public market data
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// Server client — used in API routes and the ingestion worker
// Has full access, bypasses Row Level Security
// NEVER import this in any file inside app/ or components/
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set — admin client will not work")
}
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)