// app/api/email/confirm/route.ts
//
// GET /api/email/confirm?token=...
//
// Confirmation landing for email_subscribers.verification_token. Sets
// verified=true, clears unsubscribed_at, and redirects to /dashboard/notifications
// with a status query so the UI can render a confirmation banner. No auth
// required — the token is the bearer.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.rippackscity.com"

function redirectTo(status: "ok" | "missing" | "unknown_token" | "error", message?: string) {
  const u = new URL("/dashboard/notifications", SITE_URL)
  u.searchParams.set("confirm", status)
  if (message) u.searchParams.set("detail", message.slice(0, 200))
  return NextResponse.redirect(u)
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.trim() ?? ""
  if (!token) {
    return redirectTo("missing")
  }

  const { data: row, error: fetchErr } = await (supabaseAdmin as any)
    .from("email_subscribers")
    .select("id, email, verified")
    .eq("verification_token", token)
    .maybeSingle()
  if (fetchErr) {
    return redirectTo("error", fetchErr.message)
  }
  if (!row) {
    return redirectTo("unknown_token")
  }
  if (row.verified) {
    return redirectTo("ok")
  }

  const { error: updErr } = await (supabaseAdmin as any)
    .from("email_subscribers")
    .update({ verified: true, unsubscribed_at: null })
    .eq("id", row.id)
  if (updErr) {
    return redirectTo("error", updErr.message)
  }

  return redirectTo("ok")
}
