"use client"

// components/auth/AnonSaveCollectionCta.tsx
//
// The account ask at the moment a signed-out visitor has just SEEN their collection (2026-11-17).
//
// Measured over 30 days to 11-17: 62 sessions pasted a username or wallet and saw a binder load,
// and 5 of them then clicked any sign-in control. After a signed-out look-up, the only account
// ask on the binder was the small header pill. The signed-in "This is my collection" save button
// is hidden when signed out, so the visitor who just saw the value had nothing telling them they
// could keep it.
//
// Renders only when the PARENT says the reader is affirmatively signed out (a failed or loading
// session read is not "signed out") AND a search loaded at least one moment. The sign-up link
// returns them to this binder with the same ?wallet=, where the signed-in save button asks
// "Is <handle> your wallet?" before saving it.

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect } from "react"
import { signupHref } from "@/components/auth/AccountCta"
import { trackFunnelEvent } from "@/lib/track-funnel"
import { track } from "@/lib/telemetry/track"

const shownFor = new Set<string>()

/** Where sign-up returns the visitor: this binder, with the wallet they looked up. */
export function saveReturnPath(pathname: string | null, wallet: string): string | null {
  if (!pathname || !wallet.trim()) return pathname
  return `${pathname}?wallet=${encodeURIComponent(wallet.trim())}`
}

export default function AnonSaveCollectionCta(props: {
  show: boolean
  wallet: string
  /** e.g. "nba-top-shot" — logged with the events. */
  collection: string
}) {
  const pathname = usePathname()
  const key = `${props.collection}|${props.wallet}`

  useEffect(() => {
    if (!props.show || shownFor.has(key)) return
    shownFor.add(key)
    track("anon-save-cta-shown", { collection: props.collection })
  }, [props.show, key, props.collection])

  if (!props.show) return null
  return (
    <div
      data-rpc-anon-save-cta
      style={{
        display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between",
        padding: "12px 14px", margin: "0 0 16px", border: "1px solid var(--rpc-border)", borderRadius: 10,
        background: "var(--rpc-surface)",
      }}
    >
      <span style={{ fontSize: 14, lineHeight: 1.45, color: "var(--rpc-text-secondary)", flex: "1 1 240px", minWidth: 0 }}>
        <strong style={{ color: "var(--rpc-text-primary)" }}>Is this your collection?</strong>{" "}
        Keep it with a free account: it loads here on every visit, and a weekly email shows how its value moved.
      </span>
      <Link
        href={signupHref(saveReturnPath(pathname, props.wallet))}
        onClick={() => trackFunnelEvent({ eventType: "signin_click", surface: "binder_save_signup" })}
        // brand-exception: white label on the red CTA button — theme-independent
        style={{
          padding: "10px 16px", background: "var(--rpc-red-fill)", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 13,
          textDecoration: "none", letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap",
        }}
      >
        Save my collection →
      </Link>
    </div>
  )
}
