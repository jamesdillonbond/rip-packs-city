import type { Metadata } from "next";
import { PANINI_PUBLIC } from "@/lib/launch-flags";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com";

// `robots` is the ONLY launch-gated field here. While PANINI_PUBLIC is false the
// surface is also unreachable anonymously (proxy.ts) and absent from the sitemap
// + hub, so noindex is belt-and-braces; when the flag flips, the meta robots tag
// has to drop in the SAME deploy or we ship a public board that tells Google to
// ignore it. Keying it off the same flag is what makes that impossible to forget.
// Canonical is param-stripped. OG wiring is deliberately still absent — see the
// go-live note in lib/launch-flags.ts.
export const metadata: Metadata = {
  title: "Panini WC Prizm Squeeze — Rip Packs City",
  description:
    "Which 2026 Prizm World Cup cards are still sealed in packs — remaining supply, rip %, FMV and sealed-dollar exposure across every player and parallel.",
  alternates: { canonical: `${SITE_URL}/insights/panini-squeeze` },
  ...(PANINI_PUBLIC ? {} : { robots: { index: false, follow: false } }),
};

export default function PaniniSqueezeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
