// app/api/subscribe/verify/route.ts
// GET ?token=... — flips verified=true (and re-subscribes) and redirects to /dashboard?verified=true.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.trim()
  const origin = new URL(req.url).origin

  if (!token) {
    return NextResponse.redirect(`${origin}/dashboard?verified=false`)
  }

  try {
    const { error } = await (supabaseAdmin as any)
      .from("email_subscribers")
      // Clicking the link proves control of the inbox, so it is the ONLY place an
      // opt-out is reversed (the anonymous POST /api/subscribe never touches an
      // existing row since 2026-10-09).
      .update({ verified: true, unsubscribed_at: null, updated_at: new Date().toISOString() })
      .eq("verification_token", token)

    if (error) {
      return NextResponse.redirect(`${origin}/dashboard?verified=false`)
    }
    return NextResponse.redirect(`${origin}/dashboard?verified=true`)
  } catch {
    return NextResponse.redirect(`${origin}/dashboard?verified=false`)
  }
}
