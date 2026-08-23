// app/insights/layout.tsx
//
// SEO surface for the public /insights index. Server component so the
// metadata export is honored. Per-page metadata under /insights/<x>/layout.tsx
// overrides this index-level default.

import type { Metadata } from "next"
import InsightsEmailCapture from "@/components/insights/InsightsEmailCapture"
import FunnelTracker from "@/components/FunnelTracker"
import SiteFooter from "@/components/SiteFooter"
import WalletSearchBand from "@/components/WalletSearchBand"
import { TWITTER_INHERITED, BRAND_TITLE_TEMPLATE } from "@/lib/seo"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // `absolute` reproduces exactly what the root template was already rendering
  // here ("Public Insights | Rip Packs City" — measured live); `template` is the
  // fix. A plain string title in an intermediate layout leaves its descendants
  // with no template, so every deep board under /insights rendered with no brand
  // — /insights/first-mint was "Top Shot First-Mint Trophy Tracker" flat
  // (deep-audit R31). /insights itself looked fine because it is one level down
  // and was being formatted by the ROOT template, not by this one.
  title: { absolute: "Public Insights | Rip Packs City", template: BRAND_TITLE_TEMPLATE },
  description:
    "Free, no-signup intelligence on Flow blockchain digital collectibles. Effective supply, pack reality, rookie cohort tracking, first-mint trophies, cross-collection whales, per-set scarcity, Pinnacle scarcity.",
  alternates: { canonical: `${SITE_URL}/insights` },
  openGraph: {
    title: "Public Insights — Rip Packs City",
    description:
      "Seven free intelligence wedges for Flow collectors — effective supply, pack reality, scarcity, rookie tracking, and more — plus a wallet tool.",
    url: `${SITE_URL}/insights`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights`,
        width: 1200,
        height: 630,
        alt: "Public Insights — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Public Insights — Rip Packs City",
    description:
      "Free, no-signup market intelligence for Flow collectors.",
    images: [`${SITE_URL}/api/og/insights`],
    creator: "@RipPacksCity",
  },
}

export default function InsightsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* perPath: this single instance (the layout persists across /insights/*
          navigations) re-fires insights_view for the hub AND each surface as
          the pathname changes. */}
      <FunnelTracker eventType="insights_view" perPath />
      {/* Wallet-lookup wedge for the whole /insights subtree. Mounted in the
          layout because the hub is only ~18% of insights_view — first-mint,
          squeeze, pack-sniper and the other ~30 boards are the rest, and each
          owns its own <main>, so there is no single page to put this on. The
          band self-suppresses on /insights (its hero box already carries the
          input) and on the routes that ARE wallet tools; see SUPPRESSED in
          components/WalletSearchBand.tsx. The wrapper reproduces
          .rpc-ins-hero's 1180px column so the band lines up with the board
          content rather than spanning the viewport. */}
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "20px 20px 0" }}>
        <WalletSearchBand scope="insights" />
      </div>
      {children}
      <InsightsEmailCapture />
      <SiteFooter />
    </>
  )
}
