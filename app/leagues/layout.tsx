// app/leagues/layout.tsx — the page frame for /leagues (2026-11-26): site header, one <main>, footer and
// concierge, the same frame /teams uses (app/teams/layout.tsx explains why a bare page is not enough).

import type { ReactNode } from "react"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"
import { PageContentAnchor } from "@/components/SkipToContent"
import SiteFooter from "@/components/SiteFooter"
import SupportChatConnected from "@/components/SupportChatConnected"

export default function LeaguesLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <GlobalSiteHeader />
      <PageContentAnchor />
      <main className="rpc-main" style={{ minHeight: "60vh", maxWidth: 1200, margin: "0 auto", padding: "24px 16px 80px" }}>
        {children}
      </main>
      <SiteFooter />
      <SupportChatConnected />
    </div>
  )
}
