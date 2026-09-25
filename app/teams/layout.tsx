// app/teams/layout.tsx — the page frame for /teams and every /teams/<league>/<slug> hub.
//
// 2026-09-25: the hub pages (09-23) and the new directory rendered a bare
// <div> under the root layout — no site header, no footer, no gutter, no max
// width — so on a desktop a collector arriving from a team page or a search
// result had no logo, nav, search or sign-in (the mobile bottom nav is
// display:none above 768 px), and on a phone the breadcrumb, title and cards
// sat flush against the left edge. This is the same treatment
// /pinnacle/moment/[id] got on 2026-08 (P6a, "orphaned from SEO arrivals"):
// the sticky GlobalSiteHeader, one <main>, the SiteFooter and the concierge.
// The per-collection pages get all of this from
// app/(collections)/[collection]/layout.tsx.

import type { ReactNode } from "react"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"
import SiteFooter from "@/components/SiteFooter"
import SupportChatConnected from "@/components/SupportChatConnected"

export default function TeamsLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <GlobalSiteHeader />
      <main
        className="rpc-main"
        style={{
          minHeight: "60vh",
          maxWidth: 1200,
          margin: "0 auto",
          padding: "24px 16px 80px",
        }}
      >
        {children}
      </main>
      <SiteFooter />
      <SupportChatConnected />
    </div>
  )
}
