'use client'

import { useEffect, useRef, useState } from 'react'

type ProStatus = {
  isPro: boolean
  plan: string | null
  daysRemaining: number
  loading: boolean
}

type CachedEntry = { fetchedAt: number; value: Omit<ProStatus, 'loading'> }

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CachedEntry>()

const EMPTY: Omit<ProStatus, 'loading'> = { isPro: false, plan: null, daysRemaining: 0 }

export function useProStatus(wallet: string | null): ProStatus {
  const [state, setState] = useState<ProStatus>({ ...EMPTY, loading: !!wallet })
  const lastWallet = useRef<string | null>(null)

  useEffect(() => {
    if (!wallet) {
      setState({ ...EMPTY, loading: false })
      return
    }

    const key = wallet.toLowerCase()
    const cached = cache.get(key)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setState({ ...cached.value, loading: false })
      return
    }

    let cancelled = false
    lastWallet.current = key
    setState(s => ({ ...s, loading: true }))

    fetch(`/api/pro-status?wallet=${encodeURIComponent(key)}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled || lastWallet.current !== key) return
        const value = {
          isPro: !!data.is_pro,
          plan: (data.plan as string | null) ?? null,
          daysRemaining: Number(data.days_remaining ?? 0),
        }
        cache.set(key, { fetchedAt: Date.now(), value })
        setState({ ...value, loading: false })
      })
      .catch(() => {
        if (cancelled) return
        setState({ ...EMPTY, loading: false })
      })

    return () => {
      cancelled = true
    }
  }, [wallet])

  return state
}
