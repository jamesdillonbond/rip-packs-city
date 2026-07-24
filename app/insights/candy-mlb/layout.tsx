import type { Metadata } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com";

// Pre-launch: noindex + no OG wiring until the chain-two public go-live. Canonical is param-stripped.
export const metadata: Metadata = {
  title: "Candy MLB ICONs — Rip Packs City",
  description:
    "2026 MLB Base Series ICONs (Candy Digital / Solana) — live secondary FMV, best offers, and pack expected value across every ICON and Rainbow variant.",
  alternates: { canonical: `${SITE_URL}/insights/candy-mlb` },
  robots: { index: false, follow: false },
};

export default function CandyMlbLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
