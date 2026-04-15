// app/api/subscribe/verify/route.ts
// GET ?token=... — flips verified=true and redirects to /profile?verified=true.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.trim()
  const origin = new URL(req.url).origin

  if (!token) {
    return NextResponse.redirect(`${origin}/profile?verified=false`)
  }

  try {
    const { error } = await (supabaseAdmin as any)
      .from("email_subscribers")
      .update({ verified: true, updated_at: new Date().toISOString() })
      .eq("verification_token", token)

    if (error) {
      return NextResponse.redirect(`${origin}/profile?verified=false`)
    }
    return NextResponse.redirect(`${origin}/profile?verified=true`)
  } catch {
    return NextResponse.redirect(`${origin}/profile?verified=false`)
  }
}
