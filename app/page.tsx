// app/page.tsx
//
// Public homepage. Previously this was a hard redirect ("auth-first
// platform"), which 307'd anonymous traffic and blocked indexing. Now it
// renders a real landing page server-side: H1 with the primary keyword,
// per-collection cards (internal-link targets Google will follow), a
// JSON-LD WebApplication block, and a "Sign in" CTA in the corner.
//
// Logged-in users still see the same page — they can hit /profile from
// the header. Personalization stays client-side; nothing here depends on
// auth.uid().

import Link from "next/link"
import type { Metadata } from "next"
import { publishedCollections } from "@/lib/collections"
import { organizationJsonLd } from "@/lib/seo"

export const dynamic = "force-static"
export const revalidate = 3600

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://rip-packs-city.vercel.app"

export const metadata: Metadata = {
  title: "Rip Packs City — Flow Blockchain Collector Intelligence",
  description:
    "Track FMV, hunt deals, and analyze packs across NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle. Real-time collector intelligence for Flow blockchain.",
  alternates: { canonical: BASE_URL },
  openGraph: {
    title: "Rip Packs City — Flow Blockchain Collector Intelligence",
    description:
      "Track FMV, hunt deals, and analyze packs across every Flow collection. Real-time collector intelligence for NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle.",
    url: BASE_URL,
    siteName: "Rip Packs City",
    type: "website",
    images: [{ url: "/api/og/default", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@rippackscity",
    title: "Rip Packs City — Flow Blockchain Collector Intelligence",
    description:
      "Real-time collector intelligence for NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle.",
  },
}

export default function HomePage() {
  const collections = publishedCollections()

  const websiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Rip Packs City",
    url: BASE_URL,
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${BASE_URL}/nba-top-shot/market?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
      />

      <div style={{ minHeight: "100vh", background: "#0B0B0D", color: "#fff", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
        <header style={{ borderBottom: "1px solid #26262d", padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 1280, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 20 }}>⚡</span>
            <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 18, letterSpacing: "0.08em", textTransform: "uppercase" }}>Rip Packs City</span>
          </div>
          <nav style={{ display: "flex", gap: 16, fontSize: 13 }}>
            <Link href="/about" style={{ color: "#9ca3af", textDecoration: "none" }}>About</Link>
            <Link href="/analytics" style={{ color: "#9ca3af", textDecoration: "none" }}>Analytics</Link>
            <Link href="/login" style={{ color: "#fff", textDecoration: "none", fontWeight: 600 }}>Sign in</Link>
          </nav>
        </header>

        <main style={{ maxWidth: 1280, margin: "0 auto", padding: "60px 24px" }}>
          <section style={{ textAlign: "center", padding: "40px 0 60px" }}>
            <h1 style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 56, letterSpacing: "0.04em", textTransform: "uppercase", lineHeight: 1.05, margin: "0 0 16px", maxWidth: 920, marginInline: "auto" }}>
              Flow Blockchain Collector Intelligence
            </h1>
            <p style={{ fontSize: 18, lineHeight: 1.55, color: "#cbd5e1", maxWidth: 720, margin: "0 auto 28px" }}>
              FMV pricing, deal sniping, pack EV, and wallet analytics across every Flow blockchain digital-collectible ecosystem. Built for serious collectors.
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              <Link href="/nba-top-shot/market" style={{ padding: "12px 22px", background: "#E03A2F", color: "#fff", borderRadius: 6, fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", textDecoration: "none" }}>
                Browse Market
              </Link>
              <Link href="/nba-top-shot/sniper" style={{ padding: "12px 22px", background: "transparent", color: "#fff", border: "1px solid #26262d", borderRadius: 6, fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", textDecoration: "none" }}>
                Find Deals
              </Link>
            </div>
          </section>

          <section>
            <h2 style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 22, letterSpacing: "0.06em", textTransform: "uppercase", margin: "0 0 20px", color: "#9ca3af" }}>
              Collections
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
              {collections.map((c) => (
                <Link
                  key={c.id}
                  href={`/${c.id}/overview`}
                  style={{ background: "#15151a", border: `1px solid ${c.accent}33`, borderRadius: 12, padding: "20px", textDecoration: "none", color: "#fff", display: "block" }}
                >
                  <div style={{ fontSize: 32, marginBottom: 12 }}>{c.icon}</div>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 18, letterSpacing: "0.06em", textTransform: "uppercase", color: c.accent, marginBottom: 6 }}>
                    {c.label}
                  </div>
                  <div style={{ fontSize: 13, color: "#9ca3af", lineHeight: 1.45 }}>
                    {c.pitch ?? `${c.label} collector intelligence on Flow.`}
                  </div>
                </Link>
              ))}
            </div>
          </section>

          <section style={{ padding: "60px 0 20px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 24 }}>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Real-time FMV</div>
              <div style={{ fontSize: 13, color: "#9ca3af" }}>WAP-weighted fair-market values calibrated to live Flow sales.</div>
            </div>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Sniper feed</div>
              <div style={{ fontSize: 13, color: "#9ca3af" }}>Deals below FMV, sortable by discount, recency, or absolute price.</div>
            </div>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Pack EV</div>
              <div style={{ fontSize: 13, color: "#9ca3af" }}>Expected-value calculator for every active pack, depletion-aware.</div>
            </div>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Badge intelligence</div>
              <div style={{ fontSize: 13, color: "#9ca3af" }}>Rookie Year, Top Shot Debut, Championship — live coverage and serial premiums.</div>
            </div>
          </section>
        </main>

        <footer style={{ borderTop: "1px solid #26262d", padding: "24px", textAlign: "center", fontSize: 12, color: "#6b7280" }}>
          <Link href="/about" style={{ color: "#9ca3af", marginRight: 14, textDecoration: "none" }}>About</Link>
          <Link href="/privacy" style={{ color: "#9ca3af", marginRight: 14, textDecoration: "none" }}>Privacy</Link>
          <Link href="/terms" style={{ color: "#9ca3af", textDecoration: "none" }}>Terms</Link>
        </footer>
      </div>
    </>
  )
}
