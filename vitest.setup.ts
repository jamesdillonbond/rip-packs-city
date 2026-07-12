// Placeholder env for the test process. Several lib modules construct a
// Supabase client at import time (lib/supabase.ts calls createClient with a
// non-null-asserted URL), which throws "supabaseUrl is required" when the env
// is empty. These values are never used to make a network call in the unit
// suites — the tested code paths are pure — they only satisfy the client
// constructor so the module can be imported. Real credentials come from the
// runtime environment in production, never from here.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test.supabase.co"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key"
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key"
