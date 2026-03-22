import { createClient } from '@supabase/supabase-js'

// Browser client — used in React components
// Has read-only access to public market data
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// Server client — used in API routes and the ingestion worker
// Has full access, bypasses Row Level Security
// NEVER import this in any file inside app/ or components/
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)