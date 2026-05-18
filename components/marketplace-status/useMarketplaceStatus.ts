// components/marketplace-status/useMarketplaceStatus.ts
//
// Client hook for reading per-collection marketplace status from
// /api/marketplace-status. Caches results in a module-level Map so multiple
// components on the same page (banner, sniper rows, market rows, etc.)
// share one network call per slug per session.
//
// Status is intentionally returned along with a `loaded` boolean instead of
// a Suspense-style throw — callers should default to "buyable" optimistic
// rendering during the loading window so we don't briefly grey-out
// healthy-collection buy CTAs on first paint.

"use client"

import { useEffect, useState } from "react"
import type { MarketplaceStatus } from "@/lib/marketplace-status"

export type { MarketplaceStatus } from "@/lib/marketplace-status"

const memoryCache = new Map<string, MarketplaceStatus>()
const inflight = new Map<string, Promise<MarketplaceStatus>>()

async function fetchStatus(slug: string): Promise<MarketplaceStatus> {
  const existing = memoryCache.get(slug)
  if (existing) return existing
  const pending = inflight.get(slug)
  if (pending) return pending

  const p = (async () => {
    try {
      const res = await fetch(
        "/api/marketplace-status?collection=" + encodeURIComponent(slug),
        { cache: "force-cache" }
      )
      if (!res.ok) throw new Error("HTTP " + res.status)
      const data = (await res.json()) as MarketplaceStatus
      memoryCache.set(slug, data)
      return data
    } finally {
      inflight.delete(slug)
    }
  })()
  inflight.set(slug, p)
  return p
}

export interface UseMarketplaceStatus {
  status: MarketplaceStatus | null
  loaded: boolean
}

export function useMarketplaceStatus(slug: string): UseMarketplaceStatus {
  const [status, setStatus] = useState<MarketplaceStatus | null>(
    () => memoryCache.get(slug) ?? null
  )
  const [loaded, setLoaded] = useState<boolean>(() => memoryCache.has(slug))

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    const cached = memoryCache.get(slug)
    if (cached) {
      setStatus(cached)
      setLoaded(true)
      return
    }
    fetchStatus(slug)
      .then((s) => {
        if (cancelled) return
        setStatus(s)
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  return { status, loaded }
}
