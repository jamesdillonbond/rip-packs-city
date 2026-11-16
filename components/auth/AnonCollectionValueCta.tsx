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
import { track } from "@/lib/telemetry/track"

export function isSignedOutRead(res: { ok: boolean; json: unknown }): boolean {
  return (
    res.ok &&
    !!res.json &&
    typeof res.json === "object" &&
    "user" in (res.json as Record<string, unknown>) &&
    (res.json as { user: unknown }).user == null
  )
}

// 2026-11-16: 30 days to 11-16, ~46 Google visitors landed on Panini edition
// pages (82 % left after one page) and this prompt — an 11px mono text link —
// recorded 0 clicks, with nothing to say whether it was even seen. It is now a
// button, it logs a once-per-page `anon-value-cta-shown` usage event (clicks ÷
// shows is readable), and it renders on every collection's edition page.
const shownThisLoad = new Set<string>()

export default function AnonCollectionValueCta(props: {
  /** What the visitor would add: "Panini username", "wallet", … */
  identityNoun: string
  /** Funnel surface suffix, e.g. "panini_edition". */
  surface: string
  /** What the page is about: "card" (Panini, Candy), "moment", "pin". */
  itemNoun?: string
}) {
  const itemNoun = props.itemNoun ?? "card"
  const pathname = usePathname()
  const [show, setShow] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch("/api/profile/me", { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, json: r.ok ? await r.json() : null }))
      .catch(() => ({ ok: false, json: null }))
      .then((res) => {
        if (cancelled) return
        const anon = isSignedOutRead(res)
        setShow(anon)
        if (anon && !shownThisLoad.has(`${props.surface}|${pathname}`)) {
          shownThisLoad.add(`${props.surface}|${pathname}`)
          track("anon-value-cta-shown", { surface: props.surface })
        }
      })
    return () => { cancelled = true }
  }, [props.surface, pathname])

  if (!show) return null
  return (
    <div
      data-rpc-anon-value-cta
      style={{
        display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between",
        padding: "12px 14px", border: "1px solid var(--rpc-border)", borderRadius: 10, background: "var(--rpc-surface)",
      }}
    >
      <span style={{ fontSize: 14, lineHeight: 1.45, color: "var(--rpc-text-secondary)", flex: "1 1 220px", minWidth: 0 }}>
        Own this {itemNoun}? Add your {props.identityNoun} to a free account to see what your collection is worth.
      </span>
      <Link
        href={signupHref(pathname)}
        onClick={() => trackFunnelEvent({ eventType: "signin_click", surface: `${props.surface}_signup` })}
        // brand-exception: white label on the red CTA button — theme-independent
        style={{
          padding: "10px 16px", background: "var(--rpc-red-fill)", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 13,
          textDecoration: "none", letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap",
        }}
      >
        Create free account →
      </Link>
    </div>
  )
}
