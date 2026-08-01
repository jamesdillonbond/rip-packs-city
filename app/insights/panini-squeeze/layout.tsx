import type { Metadata } from "next";
import { PANINI_PUBLIC } from "@/lib/launch-flags";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com";

const TITLE = "Panini WC Prizm Squeeze — Which 2026 World Cup Cards Are Still Sealed";
const DESCRIPTION =
  "Which 2026 Panini Prizm World Cup Soccer cards are still sealed in unopened packs — remaining supply, rip %, FMV and sealed-dollar exposure across every player and parallel. A floor, not a census. Free. No signup.";

// `robots` is the ONLY launch-gated field here. While PANINI_PUBLIC is false the
// surface is also unreachable anonymously (proxy.ts) and absent from the sitemap
// + hub, so noindex is belt-and-braces; when the flag flips, the meta robots tag
// has to drop in the SAME deploy or we ship a public board that tells Google to
// ignore it. Keying it off the same flag is what makes that impossible to forget.
// Canonical is param-stripped.
//
// OG WIRING ADDED 2026-08-01. It was previously absent, so every share of this
// LIVE board inherited the site defaults and rendered the generic "Public
// Insights" card — wrong title, wrong URL, and wrong chain (it advertised "Flow
// collectors" for a Panini card set that has nothing to do with Flow). The card
// route at /api/og/insights/panini-squeeze already existed and was already
// board-specific; only this wiring was missing.
//
// Title uses `absolute` deliberately, mirroring app/insights/candy-mlb/layout.tsx:
// the root metadata template in lib/seo.ts appends " | Rip Packs City", and the
// older insights layouts ALSO hardcode that suffix, which double-suffixes them
// ("… | Rip Packs City | Rip Packs City"). This board opts out of that bug
// rather than inheriting it.
export const metadata: Metadata = {
  title: { absolute: `${TITLE} | Rip Packs City` },
  description: DESCRIPTION,
  keywords: [
    "Panini Prizm World Cup",
    "2026 World Cup Prizm",
    "Panini digital cards",
    "sealed pack supply",
    "Prizm parallel print run",
    "World Cup card values",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/panini-squeeze` },
  openGraph: {
    title: "Panini WC Prizm Squeeze — Rip Packs City",
    description:
      "Which 2026 Prizm World Cup cards are still sealed in packs — remaining supply, rip %, FMV and sealed-dollar exposure by player and parallel.",
    url: `${SITE_URL}/insights/panini-squeeze`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/panini-squeeze`,
        width: 1200,
        height: 630,
        alt: "Panini WC Prizm Squeeze — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Panini WC Prizm Squeeze — Rip Packs City",
    description:
      "Which 2026 Prizm World Cup cards are still sealed in packs — remaining supply, rip %, FMV and sealed-dollar exposure by player and parallel.",
    images: [`${SITE_URL}/api/og/insights/panini-squeeze`],
    creator: "@RipPacksCity",
  },
  ...(PANINI_PUBLIC ? {} : { robots: { index: false, follow: false } }),
};

export default function PaniniSqueezeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
