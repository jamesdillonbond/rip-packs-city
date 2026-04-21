// lib/auth/supabase-client.ts
//
// Client-side Supabase browser client. Use this in "use client" components
// for magic-link sign-in, sign-out, and subscribing to auth state.

"use client"

import { createBrowserClient } from "@supabase/ssr"

let client: ReturnType<typeof createBrowserClient> | null = null

export function getSupabaseBrowser() {
  if (client) return client
  client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  return client
}

// Send a magic-link sign-in email. Caller shows a "check your email" confirmation.
//
// Supabase bakes `emailRedirectTo` into the link it mails out. If a user
// clicks "Send magic link" from a Vercel preview deployment URL, that preview
// host ends up in the email — and since the session cookie set by our
// /api/auth/callback is tied to the production host, Supabase bounces the
// user back to /login without exchanging the code. Fix: when
// NEXT_PUBLIC_SITE_URL is set (production only), use it in preference to
// window.location.origin. Leave the env unset on preview + local dev so
// those environments keep sending correct host-local callbacks.
export async function sendMagicLink(email: string, redirectTo?: string): Promise<{ error: string | null }> {
  const supabase = getSupabaseBrowser()
  const envOrigin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? ""
  const windowOrigin = typeof window !== "undefined" ? window.location.origin : ""
  const origin = envOrigin || windowOrigin
  const callbackUrl = `${origin}/api/auth/callback${redirectTo ? `?redirect=${encodeURIComponent(redirectTo)}` : ""}`
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: callbackUrl,
      shouldCreateUser: true,
    },
  })
  return { error: error?.message ?? null }
}

export async function signOut(): Promise<void> {
  const supabase = getSupabaseBrowser()
  await supabase.auth.signOut()
  if (typeof window !== "undefined") {
    try { window.localStorage.removeItem("rpc_owner_key") } catch {}
    window.location.href = "/login"
  }
}
