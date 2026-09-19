// Per-instance sliding-window rate limiter for PUBLIC routes whose expensive path
// an anonymous caller can drive at will (R96, 2026-09-18).
//
// WHAT IT IS, AND IS NOT. It bounds how often ONE client key can enter a route's
// expensive path on ONE serverless instance. It is not a gate (no caller is turned
// away for lack of a credential), not a global quota (each instance keeps its own
// window — a burst spread over N instances gets N× the budget), and not durable
// (a cold start empties it). That is the right shape for the R24/R96 class: the
// product is public and READ-ONLY, so the fix is to bound amplification, not to
// authenticate the reader — and a bound that is weak-but-real beats a gate that
// breaks the page for everyone who has no token.
//
// KEYING. `clientKeyFrom` reads the first hop of `x-forwarded-for` (Vercel sets it
// on every request; a client cannot strip the platform's own header) and falls
// back to `x-real-ip`. When NO key can be derived it returns null and callers
// should NOT limit — a shared "unknown" bucket would let one anonymous source
// starve everyone behind the same absence of a header, and in tests every
// NextRequest built without headers would share one bucket across a file.

export interface RateLimitVerdict {
  allowed: boolean
  /** Calls left in the window AFTER this one (0 when refused). */
  remaining: number
  /** Whole seconds until the oldest hit in the window expires (0 when allowed). */
  retryAfterSeconds: number
}

export interface InstanceRateLimiter {
  check(key: string, now?: number): RateLimitVerdict
  /** Keys currently tracked — for tests and the eviction bound. */
  size(): number
}

export function makeInstanceRateLimiter(opts: {
  limit: number
  windowMs: number
  /** Bound on tracked keys; the oldest-inserted key is evicted past it. */
  maxKeys?: number
}): InstanceRateLimiter {
  const limit = Math.max(1, Math.floor(opts.limit))
  const windowMs = Math.max(1, Math.floor(opts.windowMs))
  const maxKeys = Math.max(1, Math.floor(opts.maxKeys ?? 5000))
  const hits = new Map<string, number[]>()

  return {
    check(key, now = Date.now()) {
      const floor = now - windowMs
      const prev = hits.get(key) ?? []
      const live = prev.filter((t) => t > floor)
      if (live.length >= limit) {
        const oldest = live[0]
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
        hits.set(key, live)
        return { allowed: false, remaining: 0, retryAfterSeconds }
      }
      live.push(now)
      // Re-insert so Map iteration order is "least recently seen first".
      hits.delete(key)
      hits.set(key, live)
      while (hits.size > maxKeys) {
        const oldestKey = hits.keys().next().value
        if (oldestKey === undefined) break
        hits.delete(oldestKey)
      }
      return { allowed: true, remaining: limit - live.length, retryAfterSeconds: 0 }
    },
    size() {
      return hits.size
    },
  }
}

/** The client key for a request, or null when no platform-set client header exists. */
export function clientKeyFrom(headers: { get(name: string): string | null }): string | null {
  const xff = headers.get("x-forwarded-for")
  if (xff) {
    const first = xff.split(",")[0]?.trim()
    if (first) return first
  }
  const real = headers.get("x-real-ip")?.trim()
  return real ? real : null
}
