// app/api/auth/callback/route.ts
//
// Magic-link callback. Supabase sends the user here with ?code=<one-time code>.
// Exchange the code for a session (sets cookies) and redirect to the ?redirect=
// target. The login page passes that through from the original URL the user
// tried to visit before being gated.

import { NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get("code")
  const redirectParam = url.searchParams.get("redirect") || "/profile"
  // Never redirect to an off-site URL
  const redirectTo = redirectParam.startsWith("/") ? redirectParam : "/profile"

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", req.url))
  }

  const response = NextResponse.redirect(new URL(redirectTo, req.url))

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

  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error.message)}`, req.url))
  }

  return response
}
