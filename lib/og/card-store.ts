// lib/og/card-store.ts
//
// Stored social cards (2026-11-07). WHY: a pasted rippackscity.com/profile/<u>
// link showed NO preview in Discord. The page answered in ~0.2 s, but its card
// is rendered on demand and that render is slow — Vercel observability, the
// week to 11-07: /api/og/profile p50 10.8 s (p95 up to 26 s), /api/og/trophy-case
// p50 7.5 s (p95 ~10 s). A link-preview crawler gives up long before that, and
// the CDN cache is per-region, so the crawler's region is usually cold. At 7:16
// PM PT on 11-07 Discord fetched peanpean's card twice, both cold, no embed.
//
// So the RENDERED PNG is kept in the public `og-cards` bucket and served from
// there in well under a second; a card older than OG_CARD_FRESH_MS is
// re-rendered in the background (after()), so it follows the owner's changes.
// On a MISS the render races OG_CARD_DEADLINE_MS: if it loses, the crawler gets
// the route's neutral branded card at a 60 s cache, and the render finishes and
// stores in the background — the next fetch gets the real card.
//
// ⚠ ONLY A FULL CARD IS STORED. A route marks a card worth keeping with
// `x-og-card: full` (no art missing, a real collector); a fallback or a card
// with an ART-UNAVAILABLE tile is served but never kept, so one bad render
// cannot pin a broken picture for every later share (same rule as
// ogCacheHeaders). Never throws: a storage failure degrades to rendering.

import { OG_CACHE_HEADERS, OG_DEGRADED_CACHE_HEADERS } from "@/lib/og/brand-fonts"

export const OG_CARD_BUCKET = "og-cards"
export const OG_CARD_FULL_HEADER = "x-og-card"
export const OG_CARD_FRESH_MS = 10 * 60 * 1000
export const OG_CARD_DEADLINE_MS = 5_000
const READ_TIMEOUT_MS = 1_500
const WRITE_TIMEOUT_MS = 8_000

/** Storage key: `<kind>/<lower-cased handle>[/<slug>].png` (handles resolve case-insensitively). */
export function ogCardKey(kind: "profile" | "trophy-case", username: string, slug?: string | null): string {
  const u = encodeURIComponent(username.trim().toLowerCase())
  return slug ? `${kind}/${u}/${encodeURIComponent(slug)}.png` : `${kind}/${u}.png`
}

/** Headers that mark a render as FULL — the only kind the store keeps. */
export function fullCardHeaders(full: boolean): Record<string, string> {
  return full ? { [OG_CARD_FULL_HEADER]: "full" } : {}
}

type Stored = { bytes: Uint8Array; ageMs: number | null }

/**
 * One deadline over the WHOLE exchange — headers and body. A manual controller,
 * not AbortSignal.timeout: every caller here buffers the body completely BEFORE
 * anything is sent to the crawler, so the bound must cover the transfer (and is
 * cleared once it is done) — never left armed under a response already sent.
 */
async function bounded<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    return await fn(ac.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function readStoredCard(key: string): Promise<Stored | null> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return null
  try {
    return await bounded(READ_TIMEOUT_MS, async (signal) => {
      const res = await fetch(`${base}/storage/v1/object/public/${OG_CARD_BUCKET}/${key}`, { signal, cache: "no-store" })
      if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/png")) {
        res.body?.cancel().catch(() => {})
        if (res.status !== 400 && res.status !== 404) console.warn(`[og-card-store] read ${key} status=${res.status}`)
        return null
      }
      const lm = Date.parse(res.headers.get("last-modified") ?? "")
      return { bytes: new Uint8Array(await res.arrayBuffer()), ageMs: Number.isFinite(lm) ? Date.now() - lm : null }
    })
  } catch (err) {
    console.warn(`[og-card-store] read ${key} failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`)
    return null
  }
}

/** Keep a full card. Returns whether it LANDED; never throws. */
async function writeStoredCard(key: string, bytes: Uint8Array): Promise<boolean> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!base || !svc) return false
  try {
    const res = await bounded(WRITE_TIMEOUT_MS, (signal) => fetch(`${base}/storage/v1/object/${OG_CARD_BUCKET}/${key}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${svc}`,
        apikey: svc,
        "Content-Type": "image/png",
        // Short: the object is replaced every refresh, and a long CDN copy
        // would serve the previous card after a re-pin.
        "Cache-Control": "60",
        "x-upsert": "true",
      },
      body: bytes as Uint8Array<ArrayBuffer>,
      signal,
    }))
    res.body?.cancel().catch(() => {})
    if (!res.ok) console.warn(`[og-card-store] write ${key} status=${res.status}`)
    return res.ok
  } catch (err) {
    console.warn(`[og-card-store] write ${key} failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`)
    return false
  }
}

function png(bytes: Uint8Array, headers: Record<string, string>, tag: string): Response {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { "Content-Type": "image/png", ...headers, "X-Og-Card-Source": tag },
  })
}

/** Re-wrap a response with the 60 s cache: a fallback must not be held for a day. */
function degraded(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set("Cache-Control", OG_DEGRADED_CACHE_HEADERS["Cache-Control"])
  headers.set("X-Og-Card-Source", "deadline-fallback")
  return new Response(res.body, { status: res.status, headers })
}

/**
 * Serve `key` from the store, refreshing it in the background when stale; on a
 * miss, render under the deadline. `waitUntil` is next/server's `after` in a
 * route (injected so this stays testable and runtime-agnostic).
 */
export async function serveStoredCard(opts: {
  key: string
  render: () => Promise<Response>
  fallback: () => Promise<Response>
  waitUntil: (p: Promise<unknown>) => void
  deadlineMs?: number
}): Promise<Response> {
  const { key, render, fallback, waitUntil } = opts

  // Render; keep the bytes only when the route marked the card FULL.
  const renderAndStore = async (): Promise<Response> => {
    const res = await render()
    if (!res.ok || res.headers.get(OG_CARD_FULL_HEADER) !== "full") return res
    const bytes = new Uint8Array(await res.arrayBuffer()) // the satori render happens here
    await writeStoredCard(key, bytes)
    return png(bytes, { ...OG_CACHE_HEADERS }, "rendered")
  }

  const stored = await readStoredCard(key)
  if (stored) {
    if (stored.ageMs === null || stored.ageMs > OG_CARD_FRESH_MS) {
      waitUntil(renderAndStore().then((r) => r.body?.cancel().catch(() => {})).catch(() => {}))
    }
    // CDN copy short-ish so a refreshed card reaches crawlers within minutes.
    return png(stored.bytes, { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=86400" }, "stored")
  }

  const work = renderAndStore()
  const timer = new Promise<"late">((r) => setTimeout(() => r("late"), opts.deadlineMs ?? OG_CARD_DEADLINE_MS))
  const first = await Promise.race([work, timer]).catch(() => null)
  if (first && first !== "late") return first
  waitUntil(work.then((r) => r.body?.cancel().catch(() => {})).catch(() => {}))
  try {
    return degraded(await fallback())
  } catch {
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
