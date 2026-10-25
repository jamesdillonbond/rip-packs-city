// app/insights/autographs/layout.tsx
//
// SEO surface for the public Autographs board. Canonical is param-stripped so
// ?collection= / ?sort= URLs don't index as duplicates. Mirrors
// parallel-premiums/layout.tsx. No counts or freshness claims in the copy.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

const TITLE = "Autographed Moments — Every Signed Top Shot & All Day Edition"
const DESCRIPTION =
  "Every signed NBA Top Shot and NFL All Day edition in one place — the lowest live ask, recent sales, and what the same Moment trades for unsigned. Read from Dapper's own autograph data, edition by edition. Free, no signup."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "NBA Top Shot autographs",
    "Top Shot signed moments",
    "NFL All Day Signature Edition",
    "All Day autographed moments",
    "Top Shot Hardcourt signed",
    "Signature Series Top Shot",
    "digital autograph collectibles",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/autographs` },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${SITE_URL}/insights/autographs`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/autographs`,
        width: 1200,
        height: 630,
        alt: `${TITLE} — Rip Packs City`,
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: TITLE,
    description: "Every signed Top Shot and All Day edition — live ask, recent sales, and the unsigned price of the same Moment.",
    images: [`${SITE_URL}/api/og/insights/autographs`],
    creator: "@RipPacksCity",
  },
}

export default function AutographsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("autographs")
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      {children}
    </>
  )
}
