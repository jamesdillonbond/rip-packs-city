// app/api/profile/me/route.ts
//
// Returns the current user's identity (uuid + email + allow_list username/wallet)
// for the profile page, concierge, and the header identity widget. Returns
// { user: null } when not signed in — never 401s — so public pages can call this
// unconditionally.
//
// `display_name` is the profanity-guarded resolver chain from
// lib/user/resolveDisplayName.ts: user_profiles.display_name → profile_bio
// → allow_list.username → email-local → short wallet → "Collector".
// Use this in any UI that today greets the user by raw wallet address.

import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import { resolveDisplayName } from "@/lib/user/resolveDisplayName"

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ user: null }, {
      headers: { "Cache-Control": "no-store" },
    })
  }

  let username: string | null = null
  let walletAddr: string | null = null
  if (user.email) {
    const { data } = await (supabaseAdmin as any)
      .from("allow_list")
      .select("username, wallet_addr")
      .ilike("email", user.email)
      .limit(1)
      .maybeSingle()
    username = data?.username ?? null
    walletAddr = data?.wallet_addr ?? null
  }

  const resolved = await resolveDisplayName({
    user_id: user.id,
    email: user.email ?? null,
    wallet_addr: walletAddr,
  })

  return NextResponse.json(
    {
      user: {
        id: user.id,
        email: user.email ?? null,
        created_at: user.created_at ?? null,
        username,
        wallet_addr: walletAddr,
        display_name: resolved.display_name,
        display_name_source: resolved.source,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
