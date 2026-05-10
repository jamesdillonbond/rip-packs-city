// app/api/profile/touch/route.ts
//
// Upserts a row in user_profiles for the current authenticated user. Called
// from auth-callback paths and from any client surface that wants to refresh
// last_active_at. Accepts either:
//
//   (a) Supabase cookie session (set by @supabase/ssr on PKCE callbacks), or
//   (b) Authorization: Bearer <access_token> header. Required for the
//       implicit-flow client (/auth/confirm), where the cookies set by
//       setSession() can race the immediate fetch and the cookie path 401s.
//
// ON CONFLICT (id) only touches last_active_at + updated_at — user-set fields
// like display_name, username, wallet_address are preserved.

import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

async function resolveUserId(req: NextRequest): Promise<string | null> {
  const cookieUser = await getCurrentUser()
  if (cookieUser?.id) return cookieUser.id

  const auth = req.headers.get("authorization") ?? ""
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  try {
    const { data, error } = await (supabaseAdmin as any).auth.getUser(m[1])
    if (error) {
      console.log("[profile/touch] bearer getUser failed:", error.message)
      return null
    }
    return data?.user?.id ?? null
  } catch (err) {
    console.log("[profile/touch] bearer getUser threw:", err instanceof Error ? err.message : String(err))
    return null
  }
}

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req)
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 })
  }

  const now = new Date().toISOString()
  const { error } = await (supabaseAdmin as any)
    .from("user_profiles")
    .upsert(
      { id: userId, last_active_at: now, updated_at: now },
      { onConflict: "id", ignoreDuplicates: false }
    )

  if (error) {
    console.log("[profile/touch] upsert failed:", error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, last_active_at: now })
}
