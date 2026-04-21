// components/auth/SignOutButton.tsx
//
// Header identity widget. When signed in, renders a compact pill with the
// user's email initials and a click-to-open dropdown containing the full
// email, a Profile link, and a Sign Out button. When signed out, renders a
// Sign In link to /login.
//
// This REPLACES the raw "Profile" link in the site header; Profile is now
// accessed through the dropdown.

"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { signOut } from "@/lib/auth/supabase-client"

function initialsFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email
  const parts = local.split(/[._-]/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return local.slice(0, 2).toUpperCase()
}

export default function SignOutButton() {
  const [email, setEmail] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    fetch("/api/profile/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return
        setEmail(d?.user?.email ?? null)
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  if (!loaded) {
    return <div style={{ width: 64, height: 28, borderRadius: 4, background: "rgba(255,255,255,0.04)" }} />
  }

  if (!email) {
    return (
      <Link
        href="/login"
        style={{
          background: "rgba(224,58,47,0.15)",
          border: "1px solid rgba(224,58,47,0.4)",
          color: "#E03A2F",
          padding: "4px 10px",
          borderRadius: 4,
          fontSize: 10,
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          textDecoration: "none",
        }}
      >
        Sign In
      </Link>
    )
  }

  const initials = initialsFromEmail(email)

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={email}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "rgba(224,58,47,0.15)",
          border: "1px solid rgba(224,58,47,0.4)",
          color: "#E03A2F",
          padding: "4px 8px 4px 6px",
          borderRadius: 4,
          fontSize: 10,
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#E03A2F",
            color: "#fff",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: 0,
          }}
        >
          {initials}
        </span>
        <span>Me</span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 240,
            background: "#0D0D0D",
            border: "1px solid rgba(224,58,47,0.4)",
            borderRadius: 6,
            boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
            padding: 10,
            zIndex: 200,
          }}
        >
          <div style={{
            fontFamily: "'Share Tech Mono', monospace",
            fontSize: 10,
            color: "rgba(255,255,255,0.45)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            marginBottom: 4,
          }}>
            Signed in as
          </div>
          <div
            style={{
              fontFamily: "'Share Tech Mono', monospace",
              fontSize: 12,
              color: "#F1F1F1",
              wordBreak: "break-all",
              marginBottom: 10,
              lineHeight: 1.4,
            }}
          >
            {email}
          </div>
          <Link
            href="/profile"
            onClick={() => setOpen(false)}
            style={{
              display: "block",
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "#F1F1F1",
              textDecoration: "none",
              padding: "8px 10px",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 4,
              marginBottom: 6,
              textAlign: "center",
            }}
          >
            Profile
          </Link>
          <button
            onClick={() => { signOut() }}
            style={{
              display: "block",
              width: "100%",
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 800,
              fontSize: 12,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "#fff",
              background: "#E03A2F",
              border: "none",
              padding: "8px 10px",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Sign Out
          </button>
        </div>
      )}
    </div>
  )
}
