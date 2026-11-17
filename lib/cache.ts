type CacheEntry<T> = {
  value: T
  expiresAt: number
}

const globalCache = new Map<string, CacheEntry<unknown>>()
const pendingCache = new Map<string, Promise<unknown>>()

export function getCache<T>(key: string): T | null {
  const entry = globalCache.get(key)

  if (!entry) return null

  if (Date.now() > entry.expiresAt) {
    globalCache.delete(key)
    return null
  }

  return entry.value as T
}

export function setCache<T>(key: string, value: T, ttlMs: number) {
  globalCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  })
}

export async function getOrSetCache<T>(
  key: string,
  ttlMs: number,
  factory: () => Promise<T>
): Promise<T> {
  const cached = getCache<T>(key)
  if (cached !== null) return cached

  const pending = pendingCache.get(key)
  if (pending) return pending as Promise<T>

  const promise = factory()
    .then((value) => {
      setCache(key, value, ttlMs)
      pendingCache.delete(key)
      return value
    })
    .catch((error) => {
      pendingCache.delete(key)
      throw error
    })

  pendingCache.set(key, promise)
  return promise
}

export function deleteCache(key: string) {
  globalCache.delete(key)
  pendingCache.delete(key)
}

export function clearCacheByPrefix(prefix: string) {
  for (const key of globalCache.keys()) {
    if (key.startsWith(prefix)) globalCache.delete(key)
  }

  for (const key of pendingCache.keys()) {
    if (key.startsWith(prefix)) pendingCache.delete(key)
  }
}