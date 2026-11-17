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

import { NextRequest, NextResponse, after } from "next/server"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import { safeApiError, statusForSafeError } from "@/lib/api-error"
import { sendAccountWelcomeOnce } from "@/lib/welcome/send-account-welcome"

export const dynamic = "force-dynamic"

type TouchUser = { id: string; email?: string | null }

async function resolveUser(req: NextRequest): Promise<TouchUser | null> {
  const cookieUser = await getCurrentUser()
  if (cookieUser?.id) return { id: cookieUser.id, email: cookieUser.email }

  const auth = req.headers.get("authorization") ?? ""
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  try {
    const { data, error } = await (supabaseAdmin as any).auth.getUser(m[1])
    if (error) {
      console.log("[profile/touch] bearer getUser failed:", error.message)
      return null
    }
    return data?.user?.id ? { id: data.user.id, email: data.user.email ?? null } : null
  } catch (err) {
    console.log("[profile/touch] bearer getUser threw:", err instanceof Error ? err.message : String(err))
    return null
  }
}

// 2026-10-11 (platform review M2) — the one-time welcome email; see
// app/api/auth/callback/route.ts scheduleWelcome for why it is safe to call on
// every touch (the DB claim is the idempotency point) and why it runs after
// the response.
function scheduleWelcome(user: TouchUser) {
  const run = () => sendAccountWelcomeOnce({ userId: user.id, email: user.email })
  try {
    after(run)
  } catch {
    void run()
  }
}

export async function POST(req: NextRequest) {
  const user = await resolveUser(req)
  const userId = user?.id ?? null
  if (!user || !userId) {
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
    // `ok: false` is this route's contract with its caller and is preserved;
    // only the driver message is replaced. The full text stays in the log line
    // directly above.
    const safe = safeApiError(error)
    return NextResponse.json({ ok: false, ...safe }, { status: statusForSafeError(safe) })
  }

  scheduleWelcome(user)
  return NextResponse.json({ ok: true, last_active_at: now })
}
