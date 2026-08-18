import type { Metadata } from "next";
import { CANDY_MLB_PUBLIC } from "@/lib/launch-flags";
import { TWITTER_INHERITED } from "@/lib/seo"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com";

const TITLE = "Candy MLB ICONs — Solana Secondary Market Intelligence";
const DESCRIPTION =
  "2026 MLB Base Series ICONs (Candy Digital / Solana) — live secondary FMV, best offers, bid-ask spread, pack expected value, and holder concentration across every ICON and Rainbow variant. Free. No signup.";

// `robots` is the ONLY launch-gated field here. While CANDY_MLB_PUBLIC is false
// the surface is also unreachable anonymously (proxy.ts) and absent from the
// sitemap + hub, so noindex is belt-and-braces; when the flag flips, the meta
// robots tag has to drop in the SAME deploy or we ship a public board that
// tells Google to ignore it. Keeping it in this file, keyed off the same flag,
// is what makes that impossible to forget.
//
// Title uses `absolute` deliberately: the root metadata template in lib/seo.ts
// appends " | Rip Packs City", and the pre-existing convention on the other 29
// insights layouts is to ALSO hardcode that suffix — which double-suffixes
// every one of them ("… | Rip Packs City | Rip Packs City"). This board opts
// out of that bug rather than inheriting it. The site-wide cleanup of the other
// 29 is tracked separately; fixing them here would be an unrelated diff.
export const metadata: Metadata = {
  title: { absolute: `${TITLE} | Rip Packs City` },
  description: DESCRIPTION,
  keywords: [
    "Candy Digital MLB ICONs",
    "2026 MLB Base Series",
    "Solana sports collectibles",
    "Candy Digital secondary market",
    "MLB NFT fair market value",
    "Magic Eden MLB ICONs",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/candy-mlb` },
  openGraph: {
    title: "Candy MLB ICONs — Rip Packs City",
    description:
      "Secondary FMV, best offers, and pack EV for the 2026 MLB Base Series ICONs on Solana. An early read on a days-old market.",
    url: `${SITE_URL}/insights/candy-mlb`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/candy-mlb`,
        width: 1200,
        height: 630,
        alt: "Candy MLB ICONs — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Candy MLB ICONs — Rip Packs City",
    description:
      "Secondary FMV, best offers, and pack EV for the 2026 MLB Base Series ICONs on Solana.",
    images: [`${SITE_URL}/api/og/insights/candy-mlb`],
    creator: "@RipPacksCity",
  },
  ...(CANDY_MLB_PUBLIC ? {} : { robots: { index: false, follow: false } }),
};

export default function CandyMlbLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
