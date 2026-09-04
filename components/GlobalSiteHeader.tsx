import Link from "next/link"
import { ProBadge } from "@/components/auth/ProBadge"
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
      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 20px", height: 56, display: "flex", alignItems: "center", gap: 16, overflow: "hidden" }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, textDecoration: "none" }}>
          <RpcLogo size={36} />
          <div>
            <div style={{ fontSize: 9, fontFamily: "var(--font-mono)", letterSpacing: "0.2em", color: "var(--rpc-red-muted)" }}>@RIPPACKSCITY</div>
          </div>
        </Link>
        <TopNav />
        <div style={{ flex: 1 }} />
        <GlobalSearch />
        <ThemeToggle />
        <ProBadge />
        <SignOutButton />
      </div>
    </header>
  )
}
