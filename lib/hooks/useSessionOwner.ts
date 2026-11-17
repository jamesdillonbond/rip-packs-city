'use client'

import { useEffect, useState } from 'react'

export interface SessionOwner {
  userId: string | null
  walletAddr: string | null
  username: string | null
  email: string | null
  displayName: string | null
  loading: boolean
  /**
   * True when the server could not READ the identity enrichment, so
   * `walletAddr` / `username` are UNKNOWN rather than known-absent.
   *
   * ⚠ Set from the route's `identity_degraded`, and ALSO when this fetch itself
   * fails — otherwise the hook would collapse "the request died" into the same
   * signed-out shape it uses for a genuine anon reader, which is the defect one
   * layer up. Anything that would make a CLAIM from a null wallet ("not a
   * member") should withhold while this is true.
   */
  degraded: boolean
}

const EMPTY: Omit<SessionOwner, 'loading'> = {
  userId: null,
  walletAddr: null,
  username: null,
  email: null,
  displayName: null,
  degraded: false,
}

/**
 * The signed-in user's identity, from the cookie-backed Supabase session.
 *
 * Replaces `useFlowUser` (deleted 2026-08-08): RPC no longer connects wallets —
 * Dapper Wallet sign-in needs Dapper developer approval we do not have, and
 * everything RPC reads is public on-chain data. With no wallet-connect surface,
 * `fcl.currentUser` is permanently signed-out, so anything keyed on it renders
 * as "not a member" forever. That is exactly how the Pro badge would have gone
 * dark site-wide while `tsc` stayed green.
 *
 * `/api/profile/me` never 401s (it returns `{ user: null }` when signed out), so
 * this is safe to call unconditionally from public pages.
 *
 * This is DISPLAY STATE ONLY. The server is the trust boundary — never gate a
 * capability on what this returns.
 */
export function useSessionOwner(): SessionOwner {
  const [state, setState] = useState<SessionOwner>({ ...EMPTY, loading: true })

  useEffect(() => {
    let cancelled = false
    fetch('/api/profile/me', { cache: 'no-store', credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { __failed: true }))
      .then((d) => {
        if (cancelled) return
        // ⚠ THREE STATES, NOT TWO: request failed / signed out / signed in.
        // Collapsing the first into the second renders a signed-in reader as
        // anon, which is a false claim about their own account.
        if (d?.__failed) {
          setState({ ...EMPTY, degraded: true, loading: false })
          return
        }
        const u = d?.user
        if (!u) {
          setState({ ...EMPTY, loading: false })
          return
        }
        setState({
          userId: u.id ?? null,
          walletAddr: u.wallet_addr ?? null,
          username: u.username ?? null,
          email: u.email ?? null,
          displayName: u.display_name ?? null,
          degraded: !!u.identity_degraded,
          loading: false,
        })
      })
      .catch(() => {
        // A network/parse failure is UNKNOWN, not signed-out — same reason as above.
        if (!cancelled) setState({ ...EMPTY, degraded: true, loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
