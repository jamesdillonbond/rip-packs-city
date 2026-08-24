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

// ── AMBIENT SECRETS ARE DELETED, NOT DEFAULTED ─────────────────────────────
// ⚠ `||=` above defaults a MISSING var. It cannot help with the opposite
// problem: a var that is PRESENT in the developer's shell and ABSENT in CI.
//
// Measured 2026-08-24 on Trevor's box: `INGEST_SECRET_TOKEN` is exported from
// the user profile, so every process started there inherits the LIVE 64-char
// token. Several routes gate as `if (expectedToken && authHeader !== …)` —
// auth is enforced only when the secret is SET — so tests written against the
// unset branch got a 401 locally and the intended 200/400 in CI.
// `__tests__/api-ingest-backfill.test.ts` states that contract in its own
// header ("ONLY enforced when that env var is set") and then failed on this box
// for having it set by someone else.
//
// ⚠ The failure is environmental, so it reads as flakiness and trains a reader
// to skim a red suite — the same cost as the non-portable guards fixed the same
// day. CI is the reference environment; the test process must match it rather
// than inherit whatever the developer happens to export.
//
// ⓘ Secondary benefit, not the reason: a live token is no longer sitting in the
// vitest process where any diagnostic that dumps `process.env` would print it.
//
// A test that WANTS one of these set does `vi.stubEnv(...)`, which is unaffected
// — stubEnv assigns over whatever is (or is not) here.
for (const secret of [
  "INGEST_SECRET_TOKEN",
  "CRON_SECRET",
  "RPC_ADMIN_TOKEN",
  "FLOWTY_PROXY_TOKEN",
  "TS_PROXY_SECRET",
  "SPORTS_PROXY_SECRET",
  "ANTHROPIC_API_KEY",
]) {
  // Only INGEST_SECRET_TOKEN is ambient on the box where this was found, but
  // the list is the CLASS rather than the instance: any of these exported on
  // any machine would flip an auth branch the same way, and the next one to be
  // exported should not cost another afternoon to trace.
  delete process.env[secret]
}
