// app/moment/layout.tsx — the site header for every /moment/<id> page.
//
// 2026-09-25: /moment/[id] sits outside the (collections) group, so a desktop
// visitor arriving from a search result, a share link or a wallet's trophy
// case had NO logo, nav, search or sign-in — only the footer (the mobile
// bottom nav is display:none above 768 px). /pinnacle/moment/[id] got the
// same fix on 2026-08 (P6a, "orphaned from SEO arrivals"). The page renders
// its own <main> and SiteFooter; only the sticky header is added here.

import type { ReactNode } from "react"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"

export default function MomentLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <GlobalSiteHeader />
      {children}
    </>
  )
}
