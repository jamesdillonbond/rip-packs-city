'use client'

import { useEffect, useState } from 'react'

export interface SessionOwner {
  userId: string | null
  walletAddr: string | null
  username: string | null
  email: string | null
  displayName: string | null
  loading: boolean
}

const EMPTY: Omit<SessionOwner, 'loading'> = {
  userId: null,
  walletAddr: null,
  username: null,
  email: null,
  displayName: null,
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
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return
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
          loading: false,
        })
      })
      .catch(() => {
        if (!cancelled) setState({ ...EMPTY, loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
