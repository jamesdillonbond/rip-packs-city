"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import { getOwnerKey, onOwnerKeyChange } from "@/lib/owner-key"

// Background warming layer. Holds an in-memory cache keyed by URL (or
// arbitrary string) so navigating between pages reads instantly when the
// global warmer has already populated the relevant entries. Memory-only by
// design — never persisted, since stale data across sessions would be worse
// than a fresh fetch.

type AnyData = unknown

interface CacheEntry {
  data: AnyData
  fetchedAt: number
  ttlMs: number
}

interface WarmupContextValue {
  read: (key: string) => CacheEntry | undefined
  write: (key: string, data: AnyData, ttlMs: number) => void
  subscribe: (key: string, cb: () => void) => () => void
  fetchOrJoin: <T>(key: string, fetcher: () => Promise<T>, ttlMs: number) => Promise<T>
  prefetch: (key: string, fetcher: () => Promise<AnyData>, ttlMs?: number) => void
}

const WarmupContext = createContext<WarmupContextValue | null>(null)

const DEFAULT_TTL_MS = 60_000

interface NetworkInformation {
  saveData?: boolean
  effectiveType?: string
}

function shouldSkipNetwork(): boolean {
  if (typeof navigator === "undefined") return false
  const conn = (navigator as unknown as { connection?: NetworkInformation }).connection
  if (!conn) return false
  if (conn.saveData === true) return true
  if (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g") return true
  return false
}

function runWhenIdle(fn: () => void): void {
  if (typeof window === "undefined") return
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
  if (typeof ric === "function") {
    ric(fn)
    return
  }
  setTimeout(fn, 1)
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < entry.ttlMs
}

interface SavedWalletsPayload {
  wallets?: Array<{ wallet_addr?: string | null; username?: string | null }>
}

export default function WarmupProvider({ children }: { children: React.ReactNode }) {
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map())
  const inflightRef = useRef<Map<string, Promise<AnyData>>>(new Map())
  const subscribersRef = useRef<Map<string, Set<() => void>>>(new Map())

  const read = useCallback((key: string): CacheEntry | undefined => {
    return cacheRef.current.get(key)
  }, [])

  const notify = useCallback((key: string) => {
    const subs = subscribersRef.current.get(key)
    if (!subs) return
    subs.forEach((cb) => {
      try { cb() } catch {}
    })
  }, [])

  const write = useCallback((key: string, data: AnyData, ttlMs: number) => {
    cacheRef.current.set(key, { data, fetchedAt: Date.now(), ttlMs })
    notify(key)
  }, [notify])

  const subscribe = useCallback((key: string, cb: () => void) => {
    let set = subscribersRef.current.get(key)
    if (!set) {
      set = new Set()
      subscribersRef.current.set(key, set)
    }
    set.add(cb)
    return () => {
      const s = subscribersRef.current.get(key)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) subscribersRef.current.delete(key)
    }
  }, [])

  const fetchOrJoin = useCallback(
    async <T,>(key: string, fetcher: () => Promise<T>, ttlMs: number): Promise<T> => {
      const existing = inflightRef.current.get(key)
      if (existing) return existing as Promise<T>
      const p = (async () => {
        try {
          const data = await fetcher()
          cacheRef.current.set(key, { data, fetchedAt: Date.now(), ttlMs })
          notify(key)
          return data
        } finally {
          inflightRef.current.delete(key)
        }
      })()
      inflightRef.current.set(key, p as Promise<AnyData>)
      return p
    },
    [notify],
  )

  const prefetch = useCallback(
    (key: string, fetcher: () => Promise<AnyData>, ttlMs: number = DEFAULT_TTL_MS) => {
      const entry = cacheRef.current.get(key)
      if (entry && isFresh(entry)) return
      if (inflightRef.current.has(key)) return
      const p = (async () => {
        try {
          const data = await fetcher()
          cacheRef.current.set(key, { data, fetchedAt: Date.now(), ttlMs })
          notify(key)
          return data
        } catch {
          return undefined
        } finally {
          inflightRef.current.delete(key)
        }
      })()
      inflightRef.current.set(key, p)
      // Swallow rejections — prefetch is fire-and-forget.
      p.catch(() => {})
    },
    [notify],
  )

  // Owner-key-driven warming sequence. Fires on mount and every owner-key
  // change. Skips during SSR, on metered/slow connections, and when the tab
  // is hidden.
  useEffect(() => {
    if (typeof window === "undefined") return

    function warm(key: string) {
      if (!key) return
      if (typeof document !== "undefined" && document.hidden) return
      if (shouldSkipNetwork()) return

      runWhenIdle(() => {
        const savedCacheKey = "saved-wallets:" + key
        const savedUrl = "/api/profile/saved-wallets?ownerKey=" + encodeURIComponent(key)
        const tasks: Promise<unknown>[] = []

        // 1. Saved wallets (5 min) — feeds the per-wallet warmups below.
        tasks.push(
          (async () => {
            try {
              const cached = cacheRef.current.get(savedCacheKey)
              let payload: SavedWalletsPayload | undefined
              if (cached && isFresh(cached)) {
                payload = cached.data as SavedWalletsPayload
              } else {
                payload = await fetchOrJoin<SavedWalletsPayload>(
                  savedCacheKey,
                  async () => {
                    const res = await fetch(savedUrl)
                    if (!res.ok) throw new Error("saved-wallets " + res.status)
                    return (await res.json()) as SavedWalletsPayload
                  },
                  5 * 60_000,
                )
              }
              const wallets = (payload?.wallets ?? []).slice(0, 3)
              for (const w of wallets) {
                const input = (w.username && w.username.trim()) || (w.wallet_addr && w.wallet_addr.trim()) || ""
                if (!input) continue
                const body = JSON.stringify({ input, offset: 0, limit: 50 })
                const wsKey = "wallet-search:" + input
                prefetch(
                  wsKey,
                  async () => {
                    const res = await fetch("/api/wallet-search", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body,
                    })
                    if (!res.ok) throw new Error("wallet-search " + res.status)
                    return await res.json()
                  },
                  90_000,
                )
              }
            } catch {}
          })(),
        )

        // 2. Sniper feed (30 s) — keyed on the same URL the page uses by
        // default (no filters → just sortBy).
        const sniperKey = "/api/sniper-feed?collection=nba-top-shot&sortBy=discount"
        tasks.push(
          (async () => {
            prefetch(
              sniperKey,
              async () => {
                const res = await fetch(sniperKey, { cache: "no-store" })
                if (!res.ok) throw new Error("sniper-feed " + res.status)
                return await res.json()
              },
              30_000,
            )
          })(),
        )

        // 3. Pack listings (120 s) — keyed by collection slug.
        const packKey = "pack-listings:nba-top-shot"
        tasks.push(
          (async () => {
            prefetch(
              packKey,
              async () => {
                const res = await fetch("/api/pack-listings?collection=nba-top-shot")
                if (!res.ok) throw new Error("pack-listings " + res.status)
                return await res.json()
              },
              120_000,
            )
          })(),
        )

        Promise.allSettled(tasks).catch(() => {})
      })
    }

    function onVisibilityChange() {
      if (document.hidden) return
      const k = getOwnerKey()
      if (k) warm(k)
    }

    const initialKey = getOwnerKey()
    if (initialKey) warm(initialKey)

    const unsubKey = onOwnerKeyChange((k) => warm(k))
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      unsubKey()
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [fetchOrJoin, prefetch])

  const value: WarmupContextValue = {
    read,
    write,
    subscribe,
    fetchOrJoin,
    prefetch,
  }

  return <WarmupContext.Provider value={value}>{children}</WarmupContext.Provider>
}

interface UseWarmCacheOptions {
  ttlMs?: number
  enabled?: boolean
}

interface UseWarmCacheResult<T> {
  data: T | null
  loading: boolean
  error: unknown
  refresh: () => void
}

export function useWarmCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: UseWarmCacheOptions = {},
): UseWarmCacheResult<T> {
  const ctx = useContext(WarmupContext)
  if (!ctx) {
    throw new Error("useWarmCache must be used inside <WarmupProvider>")
  }
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const enabled = options.enabled !== false

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const initialEntry = enabled ? ctx.read(key) : undefined
  const [data, setData] = useState<T | null>(initialEntry ? (initialEntry.data as T) : null)
  const [loading, setLoading] = useState<boolean>(!initialEntry && enabled)
  const [error, setError] = useState<unknown>(null)

  const triggerFetch = useCallback(
    (background: boolean) => {
      if (!enabled) return
      if (!background) setLoading(true)
      ctx
        .fetchOrJoin<T>(key, () => fetcherRef.current(), ttlMs)
        .then((d) => {
          setData(d)
          setError(null)
        })
        .catch((e) => {
          setError(e)
        })
        .finally(() => {
          if (!background) setLoading(false)
        })
    },
    [ctx, key, ttlMs, enabled],
  )

  useEffect(() => {
    if (!enabled) return
    const unsubscribe = ctx.subscribe(key, () => {
      const entry = ctx.read(key)
      if (entry) setData(entry.data as T)
    })
    const entry = ctx.read(key)
    if (!entry) {
      triggerFetch(false)
    } else {
      setData(entry.data as T)
      setLoading(false)
      if (!isFresh(entry)) {
        triggerFetch(true)
      }
    }
    return unsubscribe
  }, [ctx, key, enabled, triggerFetch])

  const refresh = useCallback(() => {
    triggerFetch(true)
  }, [triggerFetch])

  return { data, loading, error, refresh }
}

export function usePrefetch() {
  const ctx = useContext(WarmupContext)
  if (!ctx) {
    throw new Error("usePrefetch must be used inside <WarmupProvider>")
  }
  return ctx.prefetch
}
