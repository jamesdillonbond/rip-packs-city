import type { Metadata } from "next";

// Auth-gated feature surface — NOT in proxy.ts isPublicPath and NOT in
// app/sitemap.ts (Trevor's 2026-06-19 holder-exposure decision). noindex so it
// never gets crawled even if a link leaks.
export const metadata: Metadata = {
  title: "Special Serial Owners",
  description:
    "Who holds the chase serials on Top Shot — the #1 mint, the perfect mint (#N/N), and the jersey-match serial of every edition, with the current holder and edition FMV.",
  robots: { index: false, follow: false },
};

export default function SpecialSerialOwnersLayout({ children }: { children: React.ReactNode }) {
  return children;
}
