"use client"

// AnonSignInPill — a subtle, low-weight "Sign in" affordance shown ONLY to
// anonymous visitors in the collection header chrome. Added 2026-07-17 with the
// un-gate (U3): once feature tabs are public, anon browsers need a visible path
// to sign in (to save wallets, set alerts, track cost basis) instead of only
// discovering it by bouncing off a gated action. Renders nothing for signed-in
// users. Carries ?next=<current path> so login returns them where they were.

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { getSupabaseBrowser } from "@/lib/auth/supabase-client"

export default function AnonSignInPill() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const pathname = usePathname()

  useEffect(() => {
    let active = true
    const supabase = getSupabaseBrowser()
    supabase.auth.getUser().then(({ data }: { data: { user: unknown } | null }) => {
      if (active) setSignedIn(!!data?.user)
    })
    const { data: sub } = supabase.auth.onAuthStateChange(
      (_e: string, session: { user?: unknown } | null) => {
        if (active) setSignedIn(!!session?.user)
      },
    )
    return () => {
      active = false
      sub?.subscription?.unsubscribe()
    }
  }, [])

  // Render nothing until we know (avoids a flash) and for signed-in users.
  if (signedIn !== false) return null

  const next = pathname ? `?next=${encodeURIComponent(pathname)}` : ""
  return (
    <Link
      href={`/login${next}`}
      // rpc-tap44: this pill measured 20x60px — the shortest control on the
      // site, and the anonymous visitor's only visible path to an account.
      // Hit area only; the pill's own 9px/2px-padding look is deliberate chrome.
      className="rpc-tap44"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--rpc-text-secondary)",
        border: "1px solid var(--rpc-border, rgba(255,255,255,0.14))",
        borderRadius: 4,
        padding: "2px 8px",
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      Sign in
    </Link>
  )
}
