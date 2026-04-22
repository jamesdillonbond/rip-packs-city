import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// In-process wallet-profile cache: 30s TTL, 500 max entries.
// Prevents Supabase pooler saturation during concurrent page loads
// (observed 57014 statement_timeout cascades under 6-tab traffic bursts).
// Per-Vercel-instance; not distributed — acceptable since data is
// per-user and re-fetch is cheap.
type CacheEntry = { data: unknown; expiresAt: number }
const PROFILE_CACHE = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 30_000
const CACHE_MAX_ENTRIES = 500

function getCached(key: string): unknown | null {
  const entry = PROFILE_CACHE.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    PROFILE_CACHE.delete(key)
    return null
  }
  return entry.data
}

function setCached(key: string, data: unknown): void {
  // Simple LRU eviction: drop oldest when full
  if (PROFILE_CACHE.size >= CACHE_MAX_ENTRIES) {
    const firstKey = PROFILE_CACHE.keys().next().value
    if (firstKey !== undefined) PROFILE_CACHE.delete(firstKey)
  }
  PROFILE_CACHE.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS })
}

export async function GET(req: NextRequest) {
  const rawOwnerKey = req.nextUrl.searchParams.get("ownerKey")?.trim() ?? ""

  // Reject missing, empty, and common null-like string coercions that
  // crawlers / buggy client code produce when localStorage is empty.
  if (!rawOwnerKey || rawOwnerKey === "null" || rawOwnerKey === "undefined") {
    return NextResponse.json({ error: "ownerKey param required" }, { status: 400 })
  }

  const cached = getCached(rawOwnerKey)
  if (cached !== null) {
    return NextResponse.json(cached, {
      headers: { "x-rpc-cache": "hit" },
    })
  }

  try {
    const rpcStart = Date.now()
    const { data, error } = await (supabaseAdmin as any).rpc("get_user_profile", {
      p_owner_key: rawOwnerKey,
    })
    const rpcMs = Date.now() - rpcStart
    if (error) {
      console.error(
        `[wallet/profile] RPC failed ownerKey=${rawOwnerKey} elapsed=${rpcMs}ms ` +
          `code=${error.code ?? "none"} ` +
          `hint=${(error.hint ?? "none").slice(0, 60)} ` +
          `msg=${(error.message ?? "").slice(0, 120)}`
      )
      console.error(
        `[wallet/profile] RPC details=${JSON.stringify(error.details ?? null).slice(0, 200)}`
      )
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    setCached(rawOwnerKey, data)
    if (rpcMs > 3000) {
      console.warn(`[wallet/profile] slow RPC ownerKey=${rawOwnerKey} elapsed=${rpcMs}ms`)
    }
    return NextResponse.json(data, {
      headers: { "x-rpc-cache": "miss" },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[wallet/profile] unexpected: ${msg} ownerKey=${rawOwnerKey}`)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
