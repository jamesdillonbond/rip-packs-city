"use client"

// components/auth/AnonCollectionValueCta.tsx
//
// A one-line account prompt for SIGNED-OUT readers of an edition page
// (2026-11-08). The two-week activity review found Panini edition pages were
// the site's biggest signed-out landing surface (47 views from 32 visitors, all
// signed out, mostly from search) and produced no sign-up: nothing on the page
// said what an account adds for a card the visitor might own.
//
// Renders NOTHING unless /api/profile/me SUCCEEDED and said `user: null`.
// A failed read is not "signed out" — a signed-in collector must never be
// asked to create the account they already have.

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"
import { signupHref } from "@/components/auth/AccountCta"
import { trackFunnelEvent } from "@/lib/track-funnel"

export function isSignedOutRead(res: { ok: boolean; json: unknown }): boolean {
  return (
    res.ok &&
    !!res.json &&
    typeof res.json === "object" &&
    "user" in (res.json as Record<string, unknown>) &&
    (res.json as { user: unknown }).user == null
  )
}

export default function AnonCollectionValueCta(props: {
  /** What the visitor would add: "Panini username", "wallet", … */
  identityNoun: string
  /** Funnel surface suffix, e.g. "panini_edition". */
  surface: string
}) {
  const pathname = usePathname()
  const [show, setShow] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch("/api/profile/me", { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, json: r.ok ? await r.json() : null }))
      .catch(() => ({ ok: false, json: null }))
      .then((res) => { if (!cancelled) setShow(isSignedOutRead(res)) })
    return () => { cancelled = true }
  }, [])

  if (!show) return null
  return (
    <div
      data-rpc-anon-value-cta
      className="rpc-mono"
      style={{ fontSize: 11, lineHeight: 1.6, color: "var(--rpc-text-secondary)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}
    >
      <span>Own this card? Add your {props.identityNoun} to a free account to see what your collection is worth.</span>
      <Link
        href={signupHref(pathname)}
        onClick={() => trackFunnelEvent({ eventType: "signin_click", surface: `${props.surface}_signup` })}
        style={{ color: "var(--rpc-red-text)", fontWeight: 700, textDecoration: "none", letterSpacing: "0.06em", textTransform: "uppercase" }}
      >
        Create free account →
      </Link>
    </div>
  )
}
