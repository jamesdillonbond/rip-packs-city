// lib/auth/supabase-client.ts
//
// Client-side Supabase browser client. Use this in "use client" components
// for sign-out and subscribing to auth state.
//
// ⚠️ Magic-link sign-in is gated by the soft-launch allow-list and is no
// longer initiated from the client. `sendMagicLink` POSTs to
// /api/auth/request-magic-link, which runs the email through the
// service-role-only `check_email_allowed` RPC before calling
// `supabase.auth.signInWithOtp`. The check_email_allowed RPC must NEVER be
// invoked from client code.

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

const UPSTREAM_UNAVAILABLE = "Sign-in service is temporarily unavailable. Please try again in a moment."

export type SendMagicLinkResult =
  | { ok: true; error: null }
  | { ok: false; error: string; notOnAllowList?: boolean }

// Server-gated magic-link request.
//
// Returns { ok: true } when Supabase has accepted the OTP send.
// Returns { ok: false, notOnAllowList: true } when the email isn't on the
// soft-launch allow-list — callers should render the waitlist message and
// link to /early-access. Other failures surface a readable string.
export async function sendMagicLink(email: string, redirectTo?: string): Promise<SendMagicLinkResult> {
  try {
    const res = await fetch("/api/auth/request-magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, redirect: redirectTo ?? null }),
    })

    let payload: { ok?: boolean; error?: string; reason?: string } = {}
    try {
      payload = await res.json()
    } catch {
      // Non-JSON body (e.g. CDN error page). Fall through to status-based handling.
    }

    if (res.status === 403 && payload?.reason === "not_on_allow_list") {
      return {
        ok: false,
        notOnAllowList: true,
        error: "You're on the waitlist — request access at /early-access.",
      }
    }

    if (!res.ok) {
      return { ok: false, error: payload?.error || UPSTREAM_UNAVAILABLE }
    }
    if (payload?.ok === false) {
      return { ok: false, error: payload?.error || UPSTREAM_UNAVAILABLE }
    }
    return { ok: true, error: null }
  } catch (err) {
    console.error("[sendMagicLink] network error:", err)
    return { ok: false, error: UPSTREAM_UNAVAILABLE }
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
