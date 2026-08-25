'use client'

import { useEffect, useRef, useState } from 'react'

type ProStatus = {
  isPro: boolean
  plan: string | null
  daysRemaining: number
  loading: boolean
  /**
   * ⚠ `failed` answers "did the membership READ succeed", never "is this member
   * Pro". A surface that GATES on `isPro` is making an assertion about a paying
   * member's account, so it needs to be able to tell "we know you are not Pro"
   * from "we could not find out".
   */
  failed: boolean
}

type CachedEntry = { fetchedAt: number; value: Omit<ProStatus, 'loading' | 'failed'> }

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CachedEntry>()

const EMPTY: Omit<ProStatus, 'loading' | 'failed'> = { isPro: false, plan: null, daysRemaining: 0 }

// ⚠ TWO DEFECTS FIXED HERE ON 2026-08-25, and the second is the worse one.
//
// 1. The fetch discriminated on nothing at all — `.then(r => r.json())` — so a
//    503 body (`{ error, code, retryable }`, no `is_pro` key) mapped straight to
//    `isPro: false`. `pro_users` holds 21 active members; `ProBadge` renders
//    `null` when `!isPro`, so a failed read quietly removed the PRO / FOUNDING
//    badge site-wide for real paying members.
//
// 2. 🚨 IT THEN **CACHED** THAT FOR FIVE MINUTES. The module-level Map is keyed
//    on the lowercased wallet and shared by every mount, so a single failed
//    request poisoned every subsequent render for the whole TTL — turning a
//    momentary blip into a five-minute downgrade that a reload could not clear.
//    A failure is not a result, so it is never written to the cache; the next
//    mount retries and the badge self-heals.
export function useProStatus(wallet: string | null): ProStatus {
  const [state, setState] = useState<ProStatus>({ ...EMPTY, loading: !!wallet, failed: false })
  const lastWallet = useRef<string | null>(null)

  useEffect(() => {
    if (!wallet) {
      // A real answer: no wallet means nothing to look up, not a failed read.
      setState({ ...EMPTY, loading: false, failed: false })
      return
    }

    const key = wallet.toLowerCase()
    const cached = cache.get(key)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setState({ ...cached.value, loading: false, failed: false })
      return
    }

    let cancelled = false
    lastWallet.current = key
    setState(s => ({ ...s, loading: true }))

    fetch(`/api/pro-status?wallet=${encodeURIComponent(key)}`)
      .then(async r => {
        if (!r.ok) return null
        const body = await r.json().catch(() => null)
        // Belt and braces: a body with no `is_pro` key is not an answer either,
        // whatever status carried it.
        return body && typeof body === 'object' && 'is_pro' in body ? body : null
      })
      .then(data => {
        if (cancelled || lastWallet.current !== key) return
        if (!data) {
          // NOT cached — see the note above. `isPro:false` is what the callers
          // must render (a badge is an assertion; withholding it is the honest
          // failure), but `failed` lets a gate withhold rather than deny.
          setState({ ...EMPTY, loading: false, failed: true })
          return
        }
        const value = {
          isPro: !!data.is_pro,
          plan: (data.plan as string | null) ?? null,
          daysRemaining: Number(data.days_remaining ?? 0),
        }
        cache.set(key, { fetchedAt: Date.now(), value })
        setState({ ...value, loading: false, failed: false })
      })
      .catch(() => {
        if (cancelled) return
        setState({ ...EMPTY, loading: false, failed: true })
      })

    return () => {
      cancelled = true
    }
  }, [wallet])

  return state
}
