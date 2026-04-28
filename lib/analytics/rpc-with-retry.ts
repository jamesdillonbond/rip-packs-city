// Small wrapper around Supabase RPC calls that retries connection-class
// errors with exponential backoff. Used by every /api/analytics/* route.
//
// Why: when Vercel cold-starts a batch of analytics functions in parallel
// (e.g. a fresh deploy + a user opening /analytics/loans/topshot which
// fans out to 7 RPCs), a few of them race against Supabase's pgbouncer
// connection limit and surface as 500s. The errors self-heal within
// seconds; we just need to retry rather than failing the whole route.
//
// Logic-class errors (42xxx — undefined function, syntax errors, etc.)
// are *never* retried — they will fail every attempt and burning the
// retry budget just delays the user-visible failure.

import type { SupabaseClient, PostgrestError } from "@supabase/supabase-js"

// Postgres SQLSTATE codes we treat as transient connection problems.
// 08006 — connection failure
// 08001 — sqlclient unable to establish sqlconnection
// 08000 — connection exception
// 53300 — too many connections
// 57P01 — admin shutdown / pgbouncer pool exhaustion
const TRANSIENT_CODES = new Set(["08006", "08001", "08000", "53300", "57P01"])

interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
}

function isTransient(err: PostgrestError | null | undefined): boolean {
  if (!err) return false
  // Postgrest exposes the SQLSTATE on .code; also accept connection-error
  // shapes whose code starts with "08" (any 08xxx is connection-class).
  const code = (err as any)?.code
  if (typeof code === "string") {
    if (TRANSIENT_CODES.has(code)) return true
    if (/^08\d{3}$/.test(code)) return true
    // 42xxx — explicit logic class. Never retry these.
    if (/^42\d{3}$/.test(code)) return false
  }
  // Network-y messages from the JS client (fetch failures, AbortError) are
  // transient as well. Postgrest sometimes folds them into a string-only
  // error with no SQLSTATE.
  const msg = (err.message || "").toLowerCase()
  if (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("timeout")
  ) {
    return true
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function rpcWithRetry<T>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  opts: RetryOptions = {}
): Promise<{ data: T | null; error: PostgrestError | null }> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const base = Math.max(1, opts.baseDelayMs ?? 50)

  let lastErr: PostgrestError | null = null
  for (let i = 0; i < attempts; i++) {
    const { data, error } = await (client.rpc as any)(fn, args)
    if (!error) return { data: (data as T | null) ?? null, error: null }
    lastErr = error
    if (i === attempts - 1) break
    if (!isTransient(error)) break
    // Exponential backoff: 50ms, 200ms, 800ms (with the default base of 50).
    const delay = base * Math.pow(4, i)
    console.log(
      `[rpc-with-retry] transient error on ${fn} attempt ${i + 1}/${attempts}: ${error.message || (error as any)?.code || "unknown"} — retrying in ${delay}ms`
    )
    await sleep(delay)
  }
  return { data: null, error: lastErr }
}
