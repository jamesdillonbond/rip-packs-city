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

// 2026-11-17: the account ask got 0 clicks from the 11 real visitors who saw it in its first
// week (11-10..11-17; 263 "shows" were mostly the Panini crawler). A visitor from search has no
// reason to make an account before they have seen anything for their own collection, and RPC
// needs only an identifier to show it. So the prompt now leads with a no-account LOOK-UP: the
// username/address goes to this collection's /collection page (?wallet=, which AutoSearchReader
// runs), and the account link stays as the second step. A plain GET form, so it works before
// hydration and needs no router.
export function collectionLookupAction(pathname: string | null): string | null {
  const seg = (pathname ?? "").split("/")[1] ?? ""
  return /^[a-z0-9-]+$/.test(seg) ? `/${seg}/collection` : null
}

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
  const [value, setValue] = useState("")
  const lookupAction = collectionLookupAction(pathname)

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
        display: "flex", flexDirection: "column", gap: 10,
        padding: "12px 14px", border: "1px solid var(--rpc-border)", borderRadius: 10, background: "var(--rpc-surface)",
      }}
    >
      <span style={{ fontSize: 14, lineHeight: 1.45, color: "var(--rpc-text-secondary)" }}>
        Own this {itemNoun}? Enter your {props.identityNoun} to see what your collection is worth. No account needed.
      </span>
      {lookupAction ? (
        <form
          action={lookupAction}
          method="get"
          data-rpc-anon-value-lookup
          onSubmit={(e) => {
            if (!value.trim()) { e.preventDefault(); return }
            track("anon-value-lookup", { surface: props.surface })
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <input
            name="wallet"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={props.identityNoun}
            aria-label={props.identityNoun}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            style={{
              flex: "1 1 180px", minWidth: 0, padding: "10px 12px", fontSize: 16, borderRadius: 8,
              border: "1px solid var(--rpc-border)", background: "var(--rpc-black)", color: "var(--rpc-text-primary)",
            }}
          />
          <button
            type="submit"
            // brand-exception: white label on the red CTA button — theme-independent
            style={{
              padding: "10px 16px", background: "var(--rpc-red-fill)", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 13,
              letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap", cursor: "pointer",
            }}
          >
            See my collection →
          </button>
        </form>
      ) : null}
      <span style={{ fontSize: 13, color: "var(--rpc-text-secondary)" }}>
        Want it tracked every week?{" "}
        <Link
          href={signupHref(pathname)}
          onClick={() => trackFunnelEvent({ eventType: "signin_click", surface: `${props.surface}_signup` })}
          style={{ color: "var(--rpc-text-primary)", fontWeight: 700, textDecoration: "underline" }}
        >
          Create a free account
        </Link>
      </span>
    </div>
  )
}
