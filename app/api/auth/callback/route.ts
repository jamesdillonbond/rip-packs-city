// app/api/auth/callback/route.ts
//
// Magic-link callback. Supports both the legacy PKCE/code flow (?code=...) and
// the newer email-OTP flow (?token_hash=...&type=magiclink). On success we
// exchange/verify into a session (cookies set on the response) and redirect to
// the ?redirect= target if it's a same-site path, else "/".

import { NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import type { EmailOtpType } from "@supabase/supabase-js"

const VALID_OTP_TYPES: ReadonlySet<EmailOtpType> = new Set([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
])

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get("code")
  const tokenHash = url.searchParams.get("token_hash")
  const typeParam = url.searchParams.get("type")
  const errorDescription = url.searchParams.get("error_description")
  const redirectParam = url.searchParams.get("redirect")

  const safeRedirect =
    typeof redirectParam === "string" && redirectParam.startsWith("/")
      ? redirectParam
      : "/"

  // Supabase-side failure surfaced in the redirect URL (expired link, denied, etc).
  if (!code && !tokenHash && errorDescription) {
    const target = new URL("/login", req.url)
    target.searchParams.set("error", "auth_failed")
    target.searchParams.set("description", errorDescription)
    return NextResponse.redirect(target)
  }

  // Nothing actionable on the URL — log a redacted param map so the next
  // failure leaves a trail in Vercel logs, then send the user back to /login.
  if (!code && !(tokenHash && typeParam)) {
    const SENSITIVE_KEY = /token|code|hash|secret|key/i
    const redactedParams: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      redactedParams[key] = SENSITIVE_KEY.test(key) ? "<redacted>" : value
    })
    console.warn("[auth/callback] missing_code — searchParams:", redactedParams)
    return NextResponse.redirect(new URL("/login?error=missing_code", req.url))
  }

  const response = NextResponse.redirect(new URL(safeRedirect, req.url))

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll().map((c) => ({ name: c.name, value: c.value }))
        },
        setAll(list) {
          list.forEach(({ name, value, options }) => {
            response.cookies.set({ name, value, ...options })
          })
        },
      },
    }
  )

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      const target = new URL("/login", req.url)
      target.searchParams.set("error", "auth_failed")
      target.searchParams.set("description", error.message)
      return NextResponse.redirect(target)
    }
    return response
  }

  // token_hash + type path
  const otpType = typeParam as EmailOtpType
  if (!VALID_OTP_TYPES.has(otpType)) {
    const target = new URL("/login", req.url)
    target.searchParams.set("error", "auth_failed")
    target.searchParams.set("description", `Unsupported OTP type: ${typeParam}`)
    return NextResponse.redirect(target)
  }

  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash!,
    type: otpType,
  })
  if (error) {
    const target = new URL("/login", req.url)
    target.searchParams.set("error", "auth_failed")
    target.searchParams.set("description", error.message)
    return NextResponse.redirect(target)
  }

  return response
}
