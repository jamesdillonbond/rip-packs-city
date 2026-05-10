// app/auth/confirm/page.tsx
//
// Magic-link landing page for Supabase implicit-flow OTPs. Supabase redirects
// the user here with a fragment hash like:
//
//   /auth/confirm#access_token=...&refresh_token=...&expires_at=...&type=magiclink
//
// or, on the failure path:
//
//   /auth/confirm#error=access_denied&error_description=...
//
// Browsers do not transmit URL fragments to the server, so this MUST run on
// the client. We parse the hash, hand the tokens to the browser-side Supabase
// client via setSession (which writes the auth cookies), then router.replace
// to "/" so the tokens are scrubbed from the URL bar.

"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { getSupabaseBrowser } from "@/lib/auth/supabase-client"

export default function ConfirmPage() {
  const router = useRouter()
  const [message, setMessage] = useState("Signing you in…")

  useEffect(() => {
    let cancelled = false

    async function run() {
      if (typeof window === "undefined") return

      const rawHash = window.location.hash || ""
      const hash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash
      const params = new URLSearchParams(hash)

      const accessToken = params.get("access_token")
      const refreshToken = params.get("refresh_token")
      const error = params.get("error")
      const errorDescription = params.get("error_description")

      if (!accessToken && !refreshToken) {
        if (error || errorDescription) {
          const target = new URL("/login", window.location.origin)
          target.searchParams.set("error", "auth_failed")
          if (errorDescription) target.searchParams.set("description", errorDescription)
          else if (error) target.searchParams.set("description", error)
          if (!cancelled) router.replace(target.pathname + target.search)
          return
        }
        const target = new URL("/login", window.location.origin)
        target.searchParams.set("error", "missing_token")
        if (!cancelled) router.replace(target.pathname + target.search)
        return
      }

      if (!accessToken || !refreshToken) {
        const target = new URL("/login", window.location.origin)
        target.searchParams.set("error", "session_failed")
        target.searchParams.set("description", "Magic link did not include both tokens.")
        if (!cancelled) router.replace(target.pathname + target.search)
        return
      }

      try {
        const supabase = getSupabaseBrowser()
        const { error: setErr } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
        if (setErr) {
          const target = new URL("/login", window.location.origin)
          target.searchParams.set("error", "session_failed")
          target.searchParams.set("description", setErr.message)
          if (!cancelled) router.replace(target.pathname + target.search)
          return
        }
        // Fire-and-forget: stamp user_profiles.last_active_at. setSession()
        // writes auth cookies but the immediate fetch can race that write, so
        // we ALSO pass the access_token as a Bearer header — the server's
        // touch endpoint validates it via supabaseAdmin.auth.getUser(token).
        try {
          const touchRes = await fetch("/api/profile/touch", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
          })
          if (!touchRes.ok) {
            const detail = await touchRes.text().catch(() => "")
            console.warn("[auth/confirm] touch failed", touchRes.status, detail.slice(0, 200))
          }
        } catch (touchErr) {
          console.warn("[auth/confirm] touch threw", touchErr instanceof Error ? touchErr.message : String(touchErr))
        }
        if (!cancelled) {
          setMessage("Signed in. Redirecting…")
          router.replace("/")
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error"
        const target = new URL("/login", window.location.origin)
        target.searchParams.set("error", "session_failed")
        target.searchParams.set("description", msg)
        if (!cancelled) router.replace(target.pathname + target.search)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [router])

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0a",
        color: "#fafafa",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          textAlign: "center",
          padding: "2rem",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <div
          aria-hidden
          style={{
            width: "32px",
            height: "32px",
            borderRadius: "50%",
            border: "3px solid rgba(229, 90, 76, 0.25)",
            borderTopColor: "#e55a4c",
            animation: "rpc-spin 0.9s linear infinite",
          }}
        />
        <p style={{ margin: 0, color: "#e55a4c", fontWeight: 600, letterSpacing: "0.02em" }}>
          {message}
        </p>
        <style>{`@keyframes rpc-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </main>
  )
}
