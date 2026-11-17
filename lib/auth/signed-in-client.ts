// lib/auth/signed-in-client.ts
//
// Client-side: is anyone signed in? One /api/profile/me read per page load
// (memoised for SIGNED_IN_TTL_MS), shared by the background helpers that call
// session-gated routes.
//
// WHY (2026-10-18, Cowork QA 320 px sweep): an ANONYMOUS visitor who had pasted a
// wallet carries `rpc_owner_key` in localStorage, and from then on EVERY page view
// fired two session-gated requests that could only 401 — WarmupContext's
// `/api/profile/saved-wallets?ownerKey=` (site-wide) and WalletHydrator's
// `/api/wallet/profile?ownerKey=` (every collection page) — each a red
// "Failed to load resource: 401" in the console of exactly the visitor the share
// funnel is trying to convert. `/api/profile/me` never 401s ({ user: null } when
// signed out), so it answers the question without a failed request.
//
// Three states, never two: `true` signed in · `false` signed out (the route
// ANSWERED user: null) · `null` unknown (the read failed or the body had no
// `user` key). A caller skips ONLY on `false`: an unknown must not hide a
// signed-in reader's warm-up (the same rule lib/profile/saved-wallet-for-collection.ts
// follows).

export const SIGNED_IN_TTL_MS = 60_000

let memo: { at: number; p: Promise<boolean | null> } | null = null

export function signedInOnce(fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<boolean | null> {
  if (memo && now - memo.at < SIGNED_IN_TTL_MS) return memo.p
  const p = (async (): Promise<boolean | null> => {
    try {
      const res = await fetchImpl("/api/profile/me", { cache: "no-store", credentials: "include" })
      if (!res || !res.ok) return null
      const body: unknown = await res.json().catch(() => null)
      if (body && typeof body === "object" && "user" in body) {
        return (body as { user: unknown }).user != null
      }
      return null
    } catch {
      return null
    }
  })()
  memo = { at: now, p }
  return p
}

export function _resetSignedInForTests(): void {
  memo = null
}
