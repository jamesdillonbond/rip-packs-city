// lib/abuse/anon-rate.ts
//
// DURABLE, cross-instance caps for anonymous routes that trigger expensive or
// outward work (2026-10-10 anonymous-write audit). proxy.ts's limiter is per
// lambda and in memory — a burst spread over N instances gets N× its budget, a
// cold start empties it — so it bounds nothing for a determined caller. This
// wraps public.bump_anon_action_rate (one row per (bucket, key), fixed window).
//
// ⛔ FAIL CLOSED. A cap that answers "allowed" when its counter cannot be read is
// no cap (the concierge's IP limiter failed open; see support-chat). Every helper
// here reports { allowed: false, failed: true } on an error, and callers refuse.
//
// Keys are HASHED before they are stored: a raw IP or wallet never lands in the
// table. Use "*" (unhashed) for a global cap.

import { createHash } from "node:crypto"
import { supabaseAdmin } from "@/lib/supabase"
import { clientKeyFrom } from "@/lib/http/instance-rate-limit"

export interface AnonRateVerdict {
  allowed: boolean
  /** true when the counter could not be read — the verdict is a refusal, not a count. */
  failed: boolean
  count: number | null
}

export interface AnonCap {
  bucket: string
  /** The raw key (an IP, a wallet, an email) — hashed here — or "*" for a global cap. */
  key: string
  limit: number
  windowSecs: number
}

export function hashKey(raw: string): string {
  if (raw === "*") return "*"
  return createHash("sha256").update(raw.trim().toLowerCase()).digest("hex").slice(0, 40)
}

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }

/** Bump one cap. Fails closed. */
export async function bumpAnonRate(cap: AnonCap, db: RpcClient = supabaseAdmin as unknown as RpcClient): Promise<AnonRateVerdict> {
  try {
    const { data, error } = await db.rpc("bump_anon_action_rate", {
      p_bucket: cap.bucket,
      p_key: hashKey(cap.key),
      p_limit: cap.limit,
      p_window_secs: cap.windowSecs,
    })
    if (error) {
      console.warn(`[anon-rate] ${cap.bucket} counter unavailable (refusing): ${(error as { message?: string })?.message ?? String(error)}`)
      return { allowed: false, failed: true, count: null }
    }
    const d = (data ?? {}) as { allowed?: unknown; count?: unknown }
    if (typeof d.allowed !== "boolean") return { allowed: false, failed: true, count: null }
    return { allowed: d.allowed, failed: false, count: typeof d.count === "number" ? d.count : null }
  } catch (err) {
    console.warn(`[anon-rate] ${cap.bucket} counter threw (refusing): ${err instanceof Error ? err.message : String(err)}`)
    return { allowed: false, failed: true, count: null }
  }
}

/**
 * Bump every cap in order and stop at the first refusal (so a refused caller does
 * not also spend the later, usually global, budget). Allowed only if all allow.
 */
export async function bumpAnonRates(caps: AnonCap[], db?: RpcClient): Promise<AnonRateVerdict & { refusedBucket: string | null }> {
  let last: AnonRateVerdict = { allowed: true, failed: false, count: null }
  for (const cap of caps) {
    last = await bumpAnonRate(cap, db)
    if (!last.allowed) return { ...last, refusedBucket: cap.bucket }
  }
  return { ...last, refusedBucket: null }
}

/** The caller's IP from platform headers, or null. A null key cannot be capped per-IP. */
export function anonIpKey(headers: { get(name: string): string | null }): string | null {
  return clientKeyFrom(headers)
}

// 2026-10-10 (known-issues #180 item 4): the anonymous analytics beacons
// (/api/telemetry, /api/track-funnel, /api/track-click) inserted one row per
// request with no durable cap (usage_events ~8.5k/day, funnel_events ~7.5k/day;
// pollution and table growth, not data loss). Per-IP 600/h plus a global
// 20,000/h; an IP-less request meets the global cap only. A refusal means the
// caller should DROP the event silently (a beacon never surfaces an error).
// Fails closed like every cap here: if the counter cannot be read, the insert
// would most likely fail too.
export const TELEMETRY_IP_LIMIT_PER_HOUR = 600
export const TELEMETRY_GLOBAL_LIMIT_PER_HOUR = 20_000

export async function anonTelemetryAllowed(
  headers: { get(name: string): string | null },
  route: "telemetry" | "track-funnel" | "track-click",
  db?: RpcClient,
): Promise<boolean> {
  const ip = anonIpKey(headers)
  const caps: AnonCap[] = []
  if (ip) caps.push({ bucket: `beacon:${route}:ip`, key: ip, limit: TELEMETRY_IP_LIMIT_PER_HOUR, windowSecs: 3600 })
  caps.push({ bucket: `beacon:${route}:global`, key: "*", limit: TELEMETRY_GLOBAL_LIMIT_PER_HOUR, windowSecs: 3600 })
  const v = await bumpAnonRates(caps, db)
  return v.allowed
}

