// lib/wallet-search/topshot-gql-breaker.ts
//
// Dead-host breaker for /api/wallet-search's per-moment Top Shot GraphQL leg (2026-11-15).
//
// `public-api.nbatopshot.com` answers 530 / Cloudflare 1033 (re-verified from the database's
// egress 2026-11-15 ~4:20 PM PT; decommissioned since ~08-30 — see fillFromWalletCache in the
// route). Every uncached Top Shot search still sent one request per moment (8 in flight), got a
// 429, slept 2 s in the route's withRetry, then a 530 — ~4 s of a 7–10 s search in the 11-15
// production logs — and then built the very row its failure path builds anyway (chain metadata
// + the wallet cache).
//
// After the host answers 5xx or 429, `guardTopshotGql` skips the leg for GQL_BREAKER_MS, so the
// row comes from the same failure path without the wait. HALF-OPEN BY CONSTRUCTION: once the
// window passes, the next call makes one real attempt again, so a revived host is picked up
// without a deploy. State is per instance and in memory: a cold instance pays the first attempt
// once. A success never trips it; any other error (a bad id, a GraphQL error body) never trips it.

export const GQL_BREAKER_MS = 10 * 60_000
export const GQL_BREAKER_REASON = "Top Shot GraphQL breaker open (host answering 5xx/429)"

let openUntil = 0

/** Test hook: close the breaker. */
export function resetTopshotGqlBreaker(): void {
  openUntil = 0
}

export function topshotGqlBreakerOpen(now: number = Date.now()): boolean {
  return now < openUntil
}

/** The upstream errors that mean "the host is not serving": an HTTP 5xx or a 429. */
export function tripsTopshotGqlBreaker(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /Top Shot GraphQL failed with (5\d\d|429)\b/.test(msg)
}

/** Run `call` unless the breaker is open; trip it when `call` fails with a host-down error. */
export async function guardTopshotGql<T>(call: () => Promise<T>): Promise<T> {
  if (topshotGqlBreakerOpen()) throw new Error(GQL_BREAKER_REASON)
  try {
    return await call()
  } catch (err) {
    if (tripsTopshotGqlBreaker(err)) openUntil = Date.now() + GQL_BREAKER_MS
    throw err
  }
}
