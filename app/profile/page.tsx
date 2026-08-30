// app/profile/page.tsx
//
// 🚨 WHY THIS PAGE EXISTS (2026-08-29, register R36).
// `/profile` is the LEFTMOST tab of the mobile bottom nav — the thumb-rest
// position, and the first thing a phone visitor scans. `MobileNav` is mounted by
// `HomePageMarketing`, so it renders on `/` for anonymous visitors too. Until now
// that tab was a `permanent` redirect to `/dashboard`, which is auth-gated, so the
// measured chain for a first-run visitor was:
//
//     /profile → 308 → /dashboard → 307 → /login?next=%2Fdashboard
//
// Two hops into a login wall, from the first tab a new user taps. That is the
// worst first interaction the product can offer: it converts curiosity into a
// bounce and teaches "this app is closed" before anything has been shown.
//
// ⭐⭐ THE REGISTER FRAMED THIS AS A NAV PROBLEM AND IT IS A DESTINATION PROBLEM,
// which is what makes the fix safe. The filed repair was "hide or re-point the tab
// when signed out", which needs CLIENT session state — three states, where
// "unknown" must not render as "signed out" or a signed-in user loses their tab on
// first paint, plus a 5-tabs-then-4 layout shift. That is precisely the recorded
// React #418 shape, and no gate in this repo can see a hydration error.
// Fixing the DESTINATION instead means the nav stays byte-identical for everyone,
// the branch is decided on the SERVER before the first byte, and the entire
// hydration hazard never arises. No client session state is added anywhere.
//
// ⚠ A FAILED AUTH READ RENDERS AS "SIGNED OUT", and that is deliberate here.
// `getCurrentUser()` returns null rather than throwing, so a signed-in visitor
// whose auth read fails sees this public page instead of their dashboard. That is
// degraded, not wrong: they get a working page with a sign-in link, never someone
// else's data, and one tap recovers. The opposite default — assuming signed-in —
// would send an anonymous visitor back into the wall this page exists to remove.

import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import WalletSearch from "@/components/WalletSearch"
import { getCurrentUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic" // reads the session cookie

export const metadata: Metadata = {
  // ⚠ NO BRAND SUFFIX. The root layout's title TEMPLATE appends it, and baking
  // it in here prints it twice — the R31 defect, caught by
  // metadata-no-double-brand-suffix while writing this page.
  title: "Look up any collector",
  description:
    "Paste a Top Shot username, Flow wallet or moment ID to see holdings, fair value and pack history. No account needed.",
}

// ⚠ WHAT AN ACCOUNT ACTUALLY ADDS — verified against the auth gate itself
// (proxy.ts's "walls PERSONALIZATION, not CONTENT" block), not written from
// imagination. RPC is READ-ONLY: no cart, no trading, no gifting, and this copy
// must never imply otherwise. Every item below is a real gated feature.
const SIGNED_IN_ADDS = [
  ["Save wallets", "Keep the ones you follow a tap away instead of re-pasting."],
  ["Watchlist + alerts", "Get told when an edition you care about moves."],
  ["Cost basis and P&L", "Your buys priced against current fair value."],
] as const

export default async function ProfileEntryPage() {
  // Server-side branch: no flash, no layout shift, no client session state.
  const user = await getCurrentUser()
  if (user) redirect("/dashboard")

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "40px 20px 96px", // bottom clears the 60px mobile tab bar
        display: "flex",
        flexDirection: "column",
        gap: 28,
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div
          className="rpc-mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--rpc-text-muted)",
          }}
        >
          Profile
        </div>
        {/* Answers "what is this tab?" in one line, and it is a TOOL, not a wall. */}
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 900,
            fontSize: "clamp(30px, 7vw, 44px)",
            lineHeight: 1.05,
            letterSpacing: "0.02em",
            textTransform: "uppercase",
            color: "var(--rpc-text-primary)",
            margin: 0,
          }}
        >
          Look up any collector
        </h1>
        <p
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            color: "var(--rpc-text-secondary)",
            margin: 0,
          }}
        >
          Holdings, fair value and pack history for any Top Shot username, Flow wallet
          or moment ID. <strong style={{ color: "var(--rpc-text-primary)" }}>No account needed.</strong>
        </p>
      </header>

      {/* The product's actual hook, before any ask. `surface` is DISTINCT so the
          next funnel measurement can attribute pastes to this placement rather
          than pooling them with the home and insights bands. */}
      <WalletSearch
        surface="profile_tab_anon"
        variant="hero"
        submitLabel="LOOK UP →"
        hint={
          <span style={{ color: "var(--rpc-text-muted)" }}>
            Try a username like <code className="rpc-mono">ripcity</code>, or paste a{" "}
            <code className="rpc-mono">0x…</code> wallet.
          </span>
        }
      />

      <section
        aria-labelledby="rpc-profile-signin-h"
        style={{
          border: "1px solid var(--rpc-border)",
          borderRadius: 10,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          background: "var(--rpc-surface)",
        }}
      >
        <h2
          id="rpc-profile-signin-h"
          className="rpc-mono"
          style={{
            fontSize: 11,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "var(--rpc-text-muted)",
            margin: 0,
          }}
        >
          With a free account
        </h2>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {SIGNED_IN_ADDS.map(([title, detail]) => (
            <li key={title} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--rpc-text-primary)" }}>{title}</span>
              <span style={{ fontSize: 13, lineHeight: 1.5, color: "var(--rpc-text-secondary)" }}>{detail}</span>
            </li>
          ))}
        </ul>
        {/* 48px tall: clears the 44px tap-target floor this repo measures in
            e2e/mobile-layout.spec.ts, in BOTH axes, at every width. */}
        <Link
          href="/login?next=%2Fdashboard"
          className="rpc-mono"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 48,
            padding: "0 20px",
            borderRadius: 8,
            background: "var(--rpc-red)",
            color: "#fff",
            fontSize: 13,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            textDecoration: "none",
            fontWeight: 700,
          }}
        >
          Sign in
        </Link>
      </section>

      {/* ⚠ NEVER A DEAD END. Whatever the visitor came for, there is somewhere to
          go from here that needs no account. */}
      <nav
        aria-label="Explore without an account"
        style={{ display: "flex", flexWrap: "wrap", gap: 10 }}
      >
        {[
          ["/insights", "Public insight boards"],
          ["/nba-top-shot/sniper", "Below-FMV deals"],
          ["/nba-top-shot/packs", "Pack EV"],
        ].map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="rpc-mono"
            style={{
              display: "flex",
              alignItems: "center",
              minHeight: 44,
              padding: "0 14px",
              border: "1px solid var(--rpc-border)",
              borderRadius: 8,
              fontSize: 12,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--rpc-text-secondary)",
              textDecoration: "none",
            }}
          >
            {label} →
          </Link>
        ))}
      </nav>
    </main>
  )
}
