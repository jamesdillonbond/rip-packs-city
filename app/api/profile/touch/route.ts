// app/api/profile/touch/route.ts
//
// Upserts a row in user_profiles for the current authenticated user.
// Called from the auth callback paths immediately after sign-in succeeds, and
// can be called from any client surface that wants to refresh last_active_at.
//
// ON CONFLICT (id) we only touch last_active_at and updated_at — display_name,
// username, wallet_address, avatar_url, topshot_username are user-set fields
// and must be preserved.
//
// This endpoint is the foundation for the display-name resolver and the
// /admin/beta-activity dashboard. Without it user_profiles is empty.

import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

export async function POST() {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  const now = new Date().toISOString()

  const { error } = await (supabaseAdmin as any)
    .from("user_profiles")
    .upsert(
      { id: user.id, last_active_at: now, updated_at: now },
      { onConflict: "id", ignoreDuplicates: false }
    )

  if (error) {
    console.log("[profile/touch] upsert failed:", error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, last_active_at: now })
}
