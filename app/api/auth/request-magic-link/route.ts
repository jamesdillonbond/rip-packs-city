// app/api/auth/request-magic-link/route.ts
//
// Soft-launch gate for magic-link sign-in. The browser POSTs { email, redirect }
// here instead of calling supabase.auth.signInWithOtp directly. We:
//
//   1. Run the email through `check_email_allowed` (service-role only RPC).
//   2. If not on the allow-list → 403 { ok: false, reason: "not_on_allow_list" }
//      so the login page can show the waitlist message + link to /early-access.
//   3. If allowed → call signInWithOtp on the server with an absolute
//      emailRedirectTo pointing at /auth/confirm (with the optional redirect
//      query param appended). The Supabase project is configured for the
//      implicit flow, so the magic link returns to /auth/confirm with tokens
//      in the URL fragment hash; a browser-only page consumes them and writes
//      the session cookies. Server routes cannot read URL fragments, which is
//      why the legacy /api/auth/callback target stopped working for this flow.
//
// check_email_allowed is restricted to service-role and must NEVER be called
// from client code.

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"

function buildCallbackUrl(req: NextRequest, redirect?: string | null): string {
  const envOrigin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? ""
  const reqOrigin = new URL(req.url).origin
  const origin = envOrigin || reqOrigin
  const safeRedirect =
    typeof redirect === "string" && redirect.startsWith("/") ? redirect : null
  return (
    `${origin}/auth/confirm` +
    (safeRedirect ? `?redirect=${encodeURIComponent(safeRedirect)}` : "")
  )
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const data = (body ?? {}) as { email?: unknown; redirect?: unknown }
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : ""
  const redirect = typeof data.redirect === "string" ? data.redirect : null

  if (!email || !email.includes("@")) {
    return NextResponse.json({ ok: false, error: "A valid email is required." }, { status: 400 })
  }

  // Allow-list gate. Service-role RPC — never expose to client.
  const { data: allowedRaw, error: gateError } = await supabaseAdmin.rpc("check_email_allowed", {
    p_email: email,
  })
  if (gateError) {
    console.error("[request-magic-link] check_email_allowed error", gateError)
    return NextResponse.json(
      { ok: false, error: "Sign-in service is temporarily unavailable. Please try again in a moment." },
      { status: 503 }
    )
  }
  if (allowedRaw !== true) {
    return NextResponse.json(
      { ok: false, reason: "not_on_allow_list" },
      { status: 403 }
    )
  }

  // Allow-listed — send the magic link from a server-side anon client.
  // We use the anon (publishable) client here, not service-role, so Supabase
  // applies its normal email-OTP flow.
  const supabaseAuth = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const emailRedirectTo = buildCallbackUrl(req, redirect)

  // Sanity: emailRedirectTo MUST be absolute. If it isn't, Supabase silently
  // falls back to the project Site URL and our callback never runs.
  if (!/^https?:\/\//i.test(emailRedirectTo)) {
    console.error("[request-magic-link] non-absolute emailRedirectTo computed", { emailRedirectTo })
    return NextResponse.json(
      { ok: false, error: "Sign-in service is misconfigured. Please contact support." },
      { status: 500 }
    )
  }

  const { error: otpError } = await supabaseAuth.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo,
      shouldCreateUser: true,
    },
  })

  if (otpError) {
    console.error("[request-magic-link] signInWithOtp error", otpError)
    const msg = otpError.message || "Sign-in service is temporarily unavailable. Please try again in a moment."
    const status = (otpError as { status?: number }).status ?? 500
    return NextResponse.json({ ok: false, error: msg }, { status })
  }

  return NextResponse.json({ ok: true })
}
