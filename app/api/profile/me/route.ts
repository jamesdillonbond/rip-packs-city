// app/api/profile/me/route.ts
//
// Returns the current user's identity (uuid + email) for the profile page,
// concierge, and the header identity widget. Returns { user: null } when
// not signed in — never 401s — so public pages can call this unconditionally.

import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth/supabase-server"

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ user: null }, {
      headers: { "Cache-Control": "no-store" },
    })
  }
  return NextResponse.json(
    {
      user: {
        id: user.id,
        email: user.email ?? null,
        created_at: user.created_at ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
