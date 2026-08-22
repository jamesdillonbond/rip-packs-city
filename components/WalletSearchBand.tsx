"use client"

// components/WalletSearchBand.tsx
//
// The compact, layout-level placement of the wallet-lookup wedge.
//
// WHY THE LAYOUT AND NOT A PAGE (2026-07-25, measured from funnel_events):
// The wedge input historically lived only on the marketing home — the LEAST
// visited surface (home_view 20/7d vs collection_view 131/7d, insights_view
// 40/7d). The obvious fix ("put it on the collection landing page") is a trap:
// broken down by tab, /overview is only 8.8% of collection_view. The real
// distribution over 30d is
//     /<c>/edition/*  51.4%   /<c>/pack/*  15.5%
//     /<c>/collection 14.2%   /<c>/overview 8.8%   rest 10%
// and on /insights the hub itself is only ~18% of insights_view (first-mint,
// squeeze, pack-sniper and the other boards are the rest). A page-level block
// on either landing page would therefore reach <10% of the traffic it is meant
// to catch. Rendering ONE instance from each of the two layouts reaches 100%
// of both subtrees for one mount.
//
// WHY THIS IS NOT A SECOND HEADER (RPC_DESIGN_SYSTEM §3):
// §3 reserves header / nav / ticker for the (collections) layout, and forbids a
// second one anywhere in that subtree. This band carries no logo, no nav links,
// no breadcrumb, no collection switcher, no tab bar and no ticker — it is a
// single-row content card that renders INSIDE the existing <main>, above
// {children}, sharing that <main>'s max-width and padding. It is the first
// content block, not chrome: nothing here duplicates a chrome affordance.
//
// SCALE (§9 mobile): one line of copy + the 52px input row. At 390px the copy
// and the input stack, giving ~112px total — one band, not a hero. The 32px
// decorative glyph and 32px padding of the old /overview hero are deliberately
// NOT reproduced. Touch targets are the 52px input and 52px button (>=44px).
//
// It renders on the server pass (so the entry point is in the delivered HTML
// and is crawlable/verifiable) and removes itself client-side once a wallet is
// already known, so a returning collector is never nagged.
//
// WHO IT IS FOR (2026-08-22): ANONYMOUS visitors only. A SIGNED-IN collector
// already has a wallet on their account — the collection tab auto-loads it on
// mount (rpc_last_wallet / rpc_owner_key), WalletHydrator keeps the session
// warm and WalletPreloader pre-fetches the owned set — so asking them to paste
// an address is pure noise at the top of every tab. The auth check is
// affirmative-only: we hide on a KNOWN session, never on a failed/unknown auth
// read, so a Supabase hiccup leaves the anon entry point exactly where it is.

import { useEffect, useState, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import WalletSearch from "@/components/WalletSearch"
import { getSupabaseBrowser } from "@/lib/auth/supabase-client"

// Kill switch. Absent/anything-but-"off" = on, so no env var is required to
// ship; setting NEXT_PUBLIC_WALLET_BAND=off in Vercel disables both placements
// at the next build without a code change.
const DISABLED = process.env.NEXT_PUBLIC_WALLET_BAND === "off"

// Routes that ARE the wallet tool, or that already carry their own dedicated
// wallet hero. A second box on these would be redundant, not reachable.
const SUPPRESSED = new Set([
  "/insights", // hub — has the InsightsWalletSearch hero in its own <section>
  "/insights/account-value", // AccountValueSearch is the page's whole point
  "/insights/tc-report", // the report itself, driven by ?wallet=
  "/insights/squeeze-check", // wallet-scoped tool with its own input
])

const COPY: Record<string, { title: string; placeholder: string; hint: ReactNode }> = {
  "nba-top-shot": {
    title: "What's your collection worth?",
    placeholder: "Top Shot username or 0x wallet…",
    hint: "Free, no signup. Total FMV + your top moments.",
  },
  __default: {
    title: "What's your collection worth?",
    placeholder: "Flow wallet address (0x…)",
    hint: "Free, no signup. Total FMV + your top moments.",
  },
  __insights: {
    title: "Check your own wallet",
    placeholder: "Top Shot username or 0x wallet…",
    hint: "Free, no signup. Runs the full Top Collector Report.",
  },
}

const CSS = `
.rpc-wsb{display:flex;align-items:center;justify-content:space-between;gap:var(--space-lg);
  flex-wrap:wrap;padding:14px 18px;margin-bottom:20px;
  padding-left:max(18px,env(safe-area-inset-left));
  padding-right:max(18px,env(safe-area-inset-right));}
.rpc-wsb-copy{display:flex;flex-direction:column;gap:3px;min-width:0;}
.rpc-wsb-title{font-family:var(--font-display);font-weight:800;font-size:var(--text-lg);
  letter-spacing:0.04em;text-transform:uppercase;color:var(--rpc-text-primary);line-height:1.1;}
.rpc-wsb-hint{font-family:var(--font-mono);font-size:var(--text-sm);
  letter-spacing:0.04em;color:var(--rpc-text-muted);}
@media (max-width:640px){
  .rpc-wsb{flex-direction:column;align-items:stretch;gap:10px;padding:12px 14px;margin-bottom:16px;}
  .rpc-wsb-title{font-size:var(--text-base);}
  .rpc-wsb-hint{display:none;}
}
`

export default function WalletSearchBand({
  scope,
  collectionId,
}: {
  /**
   * Which layout mounted this. Drives copy, destination and — via `surface` —
   * the attribution axis in funnel_events, so the next measurement can say
   * WHICH placement produced the pastes rather than just "more pastes".
   */
  scope: "collection" | "insights"
  collectionId?: string
}) {
  const pathname = usePathname()
  const [hasWallet, setHasWallet] = useState(false)
  const [signedIn, setSignedIn] = useState(false)

  // Signed-in visitors never see the band. Mirrors AnonSignInPill's contract
  // (components/AnonSignInPill.tsx) so the two affordances agree on what
  // "signed in" means. Only a resolved session flips this — a rejected
  // getUser(), a missing browser client, or a still-pending check all leave
  // `signedIn` false and the band rendered, which is the anon default.
  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined
    try {
      const supabase = getSupabaseBrowser()
      supabase.auth
        .getUser()
        .then(({ data }: { data: { user: unknown } | null }) => {
          if (active) setSignedIn(!!data?.user)
        })
        .catch(() => {
          /* auth read failed — stay anon, keep the band up */
        })
      const { data: sub } = supabase.auth.onAuthStateChange(
        (_e: string, session: { user?: unknown } | null) => {
          if (active) setSignedIn(!!session?.user)
        },
      )
      unsubscribe = () => sub?.subscription?.unsubscribe()
    } catch {
      /* no browser client (missing env) — stay anon */
    }
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    // Deferred one tick on purpose. The band MUST be in the server-rendered
    // HTML (that is what makes the entry point crawlable and verifiable), so
    // the "already know this visitor's wallet" check can only run after
    // hydration — and it is scheduled rather than called synchronously in the
    // effect body so it does not cascade a render (react-hooks/set-state-in-
    // effect). The visible cost is one frame of a band a returning collector
    // does not need; the alternative is a hydration mismatch.
    let cancelled = false
    const id = setTimeout(() => {
      if (cancelled) return
      try {
        const known =
          localStorage.getItem("rpc_last_wallet") ||
          localStorage.getItem("rpc_collection_last_wallet")
        if (known) setHasWallet(true)
      } catch {
        /* private mode — just leave the band up */
      }
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [])

  if (DISABLED || hasWallet || signedIn) return null
  if (pathname && SUPPRESSED.has(pathname)) return null

  const copy =
    scope === "insights" ? COPY.__insights : COPY[collectionId ?? ""] ?? COPY.__default

  return (
    <section
      className="rpc-card rpc-wsb"
      aria-label="Look up a wallet"
      data-rpc-wallet-band={scope}
    >
      <style>{CSS}</style>
      <div className="rpc-wsb-copy">
        <span className="rpc-wsb-title">{copy.title}</span>
        <span className="rpc-wsb-hint">{copy.hint}</span>
      </div>
      <WalletSearch
        // Distinct per placement — see the surface convention note in
        // WalletSearch: explicit strings for interaction events, pathname for
        // the perPath view events.
        surface={scope === "insights" ? "insights_layout" : "collection_layout"}
        variant="inline"
        // Anon-safe destinations only. /share is the public Total-FMV card;
        // tc-report is the public deep report. Never /dashboard (auth-gated).
        destination={scope === "insights" ? "tc-report" : "share"}
        placeholder={copy.placeholder}
        ariaLabel="Look up a Top Shot username or Flow wallet address"
        submitLabel="Go →"
        pendingLabel="…"
        style={{ maxWidth: 420, flex: "1 1 300px" }}
        onSubmitValue={(raw) => {
          // Keep the in-app tabs' existing hydration contract: they read the
          // active wallet from localStorage (WalletHydrator).
          try {
            localStorage.setItem("rpc_last_wallet", raw)
            localStorage.setItem("rpc_collection_last_wallet", raw)
          } catch {
            /* ignore */
          }
        }}
      />
    </section>
  )
}
