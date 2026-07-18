import type { Metadata } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com";

// Pre-launch: noindex + no OG wiring until the multi-chain public go-live. Canonical is param-stripped.
export const metadata: Metadata = {
  title: "Panini WC Prizm Squeeze — Rip Packs City",
  description:
    "Which 2026 Prizm World Cup cards are still sealed in packs — remaining supply, rip %, FMV and sealed-dollar exposure across every player and parallel.",
  alternates: { canonical: `${SITE_URL}/insights/panini-squeeze` },
  robots: { index: false, follow: false },
};

export default function PaniniSqueezeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
