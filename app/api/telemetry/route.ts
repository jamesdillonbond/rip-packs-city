// app/api/telemetry/route.ts
//
// Lightweight beacon endpoint backing lib/telemetry/track.ts. Each POST
// inserts one row into usage_events. The client never has to know the
// user's wallet address — we resolve it server-side from the auth session
// + allow_list, falling back to a "user:<auth_id>" sentinel for users
// who are signed in but haven't connected a Flow wallet yet, and "anon"
// for fully unauthenticated callers.
//
// Body shape: { feature: string, metadata?: object }
// `feature` is required, ≤80 chars, lowercase + dashes/underscores
// (we trim/normalize defensively so a typo at a callsite doesn't poison
// the table). `metadata` is shallow-cloned to drop any keys whose values
// aren't JSON-safe primitives or simple objects.
//
// Returns 204 on success — the client doesn't need a body and we don't
// want telemetry to ever block UI.

import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

const MAX_FEATURE_LEN = 80
const MAX_METADATA_BYTES = 4096

function normalizeFeature(input: unknown): string | null {
  if (typeof input !== "string") return null
  const trimmed = input.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_")
  if (!trimmed) return null
  return trimmed.slice(0, MAX_FEATURE_LEN)
}

function safeMetadata(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null
  try {
    const json = JSON.stringify(input)
    if (json.length > MAX_METADATA_BYTES) {
      return { _truncated: true, _bytes: json.length }
    }
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  let body: { feature?: unknown; metadata?: unknown } = {}
  try {
    body = await req.json()
  } catch {
    return new NextResponse(null, { status: 204 })
  }

  const feature = normalizeFeature(body.feature)
  if (!feature) {
    return new NextResponse(null, { status: 204 })
  }

  // Resolve identity. Authed users get their allow_list wallet_addr or
  // a "user:<uuid>" sentinel; unauthed get "anon".
  let walletAddress = "anon"
  try {
    const user = await getCurrentUser()
    if (user) {
      let walletFromAllowList: string | null = null
      if (user.email) {
        const { data } = await (supabaseAdmin as any)
          .from("allow_list")
          .select("wallet_addr")
          .ilike("email", user.email)
          .limit(1)
          .maybeSingle()
        walletFromAllowList = (data?.wallet_addr as string | null | undefined) ?? null
      }
      walletAddress = walletFromAllowList || `user:${user.id}`
    }
  } catch {
    // Fall through with walletAddress = "anon".
  }

  const metadata = safeMetadata(body.metadata)

  // Fire-and-forget insert. We deliberately swallow errors here — telemetry
  // must never surface as a 5xx in the UI.
  ;(supabaseAdmin as any)
    .from("usage_events")
    .insert({
      wallet_address: walletAddress,
      feature_name: feature,
      metadata,
    })
    .then((r: { error: { message: string } | null }) => {
      if (r.error) console.log("[telemetry]", feature, r.error.message)
    })

  return new NextResponse(null, { status: 204 })
}
