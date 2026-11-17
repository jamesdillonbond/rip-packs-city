"use client"

// The share card's "Create a free account" button (2026-10-14).
//
// Measured 10-08..10-14: 10 visits pasted a wallet and landed here, 0 clicked
// sign-in, and the plain <a href="/login"> it replaced (a) logged nothing, so
// the click could not be counted, and (b) dropped the wallet — a visitor who
// did sign up landed on an empty /dashboard. `next` brings them back to THIS
// card, where SaveToCollectionCTA (signed-in only) saves the wallet in one
// click. LoginClient reads `next` (app/login/LoginClient.tsx).

import { trackFunnelEvent } from "@/lib/track-funnel"

// 2026-11-16: a second placement directly under the Total FMV hero
// (surface "share_hero"). 30 days to 11-16: 42 signed-out visitors viewed share
// cards and 3 clicked the bottom button ("share_cta"), which sits below the series
// chart; the hero slot went to an email capture with 1 interaction in 75 shows.
// Separate surfaces so the two placements can be compared.
export type ShareSignUpSurface = "share_cta" | "share_hero"

export default function ShareSignUpLink({
  wallet,
  surface = "share_cta",
  label = "Create a free account →",
}: {
  wallet: string
  surface?: ShareSignUpSurface
  label?: string
}) {
  // 2026-11-08: `intent=signup` heads /login as account creation, matching the
  // button's words (the 11-07 header pills do the same). ChatGPT referrals land
  // here via /insights/account-value — 6 visitors pasted a wallet in two weeks.
  const href = `/login?intent=signup&next=${encodeURIComponent(`/share/${wallet}`)}`
  return (
    <a
      href={href}
      onClick={() => trackFunnelEvent({ eventType: "signin_click", walletAddress: wallet, surface })}
      // brand-exception: white label on the red CTA button — theme-independent
      style={{ display: "inline-block", padding: "12px 28px", background: "var(--rpc-red-fill)", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none", letterSpacing: "0.06em" }}
    >
      {label}
    </a>
  )
}
