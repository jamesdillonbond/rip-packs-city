import type { Metadata } from "next";

// /trades/block — the Trade Block (Trevor, 2026-11-02: "Browsing can be public"). The
// parent /trades layout is signed-in and noindex; the block's browse and listing pages are
// anon-readable at the proxy, so this layout re-opens indexing for them. A closed or
// expired listing turns itself back to noindex in its own generateMetadata.
export const metadata: Metadata = {
  title: "Trade Block",
  description:
    "Collectors' trade listings on Rip Packs City: what they'd trade, what they want back. NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle and UFC Strike — asset for asset, no cash.",
  robots: { index: true, follow: true },
  alternates: { canonical: "/trades/block" },
};

export default function TradeBlockLayout({ children }: { children: React.ReactNode }) {
  return children;
}
