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
// Normalize anything thrown or returned from Supabase into a readable string.
// Supabase's JS client sometimes throws Error instances (fetch-level failures),
// sometimes returns { error: AuthError }, and at the HTTP layer (504/503) may
// surface errors without a readable .message — which stringify to "{}".
function readableErrorMessage(err: unknown): string {
  if (!err) return ""
  if (typeof err === "string") return err
  if (err instanceof Error) return err.message || ""
  if (typeof err === "object") {
    const anyErr = err as { message?: unknown; error_description?: unknown; msg?: unknown }
    if (typeof anyErr.message === "string" && anyErr.message) return anyErr.message
    if (typeof anyErr.error_description === "string" && anyErr.error_description) return anyErr.error_description
    if (typeof anyErr.msg === "string" && anyErr.msg) return anyErr.msg
  }
  return ""
}

const UPSTREAM_UNAVAILABLE = "Sign-in service is temporarily unavailable. Please try again in a moment."

export async function sendMagicLink(email: string, redirectTo?: string): Promise<{ error: string | null }> {
  const supabase = getSupabaseBrowser()
  const envOrigin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? ""
  const windowOrigin = typeof window !== "undefined" ? window.location.origin : ""
  const origin = envOrigin || windowOrigin
  const callbackUrl = `${origin}/api/auth/callback${redirectTo ? `?redirect=${encodeURIComponent(redirectTo)}` : ""}`
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: callbackUrl,
        shouldCreateUser: true,
      },
    })
    if (!error) return { error: null }
    const msg = readableErrorMessage(error)
    if (!msg) {
      console.error("[sendMagicLink] unreadable Supabase error:", error)
      return { error: UPSTREAM_UNAVAILABLE }
    }
    return { error: msg }
  } catch (err) {
    const msg = readableErrorMessage(err)
    if (!msg) {
      console.error("[sendMagicLink] threw without readable message:", err)
      return { error: UPSTREAM_UNAVAILABLE }
    }
    return { error: msg }
  }
}

export async function signOut(): Promise<void> {
  const supabase = getSupabaseBrowser()
  await supabase.auth.signOut()
  if (typeof window !== "undefined") {
    try { window.localStorage.removeItem("rpc_owner_key") } catch {}
    window.location.href = "/login"
  }
}
