import Link from "next/link"
import SignOutButton from "@/components/auth/SignOutButton"
import RpcLogo from "@/components/RpcLogo"
import TopNav from "@/components/TopNav"
import ThemeToggle from "@/components/ThemeToggle"
import GlobalSearch from "@/components/search/GlobalSearch"

// Site-wide sticky header (no collection dependency). Extracted from the
// (collections) group layout so top-level routes OUTSIDE that group — e.g.
// /pinnacle/moment/[id] — can render the same global nav instead of being
// orphaned with no way back into the site.
export default function GlobalSiteHeader() {
  return (
    <header style={{ background: "var(--rpc-header-bg)", borderBottom: "1px solid var(--rpc-border-subtle)", position: "sticky", top: 0, zIndex: 100 }}>
      <div className="rpc-gsh-row" style={{ maxWidth: 1440, margin: "0 auto", padding: "0 20px", height: 56, display: "flex", alignItems: "center", gap: 16, overflow: "hidden" }}>
        <Link href="/" className="rpc-tap44" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, textDecoration: "none" }}>
          <RpcLogo size={36} />
          <div className="rpc-gsh-label">
            <div style={{ fontSize: 9, fontFamily: "var(--font-mono)", letterSpacing: "0.2em", color: "var(--rpc-red-muted)" }}>@RIPPACKSCITY</div>
          </div>
        </Link>
        <TopNav />
        <div style={{ flex: 1 }} />
        <GlobalSearch />
        <ThemeToggle />
        <SignOutButton />
      </div>
      {/* 2026-09-25: at a phone width the row (logo + handle + search ≥ 110 px +
          theme + SIGN IN, 16 px gaps, 20 px gutters) overflowed its
          overflow:hidden box, so the SIGN IN button was cut to "SIGN" at 390 px
          (true-mobile sweep screenshot). The handle is decorative beside the
          logo; drop it and tighten the gaps under 480 px so every control fits
          at 320 px (36 + 110 + 32 + ~70 + 3 × 8 + 24 ≈ 296). */}
      {/* 2026-10-03: the same squeeze one breakpoint up. Between 768 and
          1023 px the desktop nav is shown and its two-word labels wrapped
          inside their links; with the nav now unshrinkable (TopNav.tsx) the
          handle and the 16 px gaps are what give the search box its room —
          hide the one and tighten the other at md only. Simulated live before
          shipping: search ≥ 179 px and SIGN IN fully visible at 768 px. */}
      <style>{`
        @media (max-width: 480px) {
          .rpc-gsh-row { gap: 8px !important; padding: 0 12px !important; }
          .rpc-gsh-label { display: none !important; }
        }
        @media (min-width: 768px) and (max-width: 1023.98px) {
          .rpc-gsh-row { gap: 8px !important; } /* 10 → 8 on 2026-10-03 PM: see TopNav.tsx */
          .rpc-gsh-label { display: none !important; }
        }
      `}</style>
    </header>
  )
}
