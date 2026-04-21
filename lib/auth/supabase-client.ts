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
export async function sendMagicLink(email: string, redirectTo?: string): Promise<{ error: string | null }> {
  const supabase = getSupabaseBrowser()
  const origin = typeof window !== "undefined" ? window.location.origin : ""
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
