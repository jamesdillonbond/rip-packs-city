// app/blog/page.tsx
//
// Minimal blog index. Lists published long-form pieces in reverse-chronological
// order. Currently a one-entry list — Pinnacle Star Wars Day 2026 — but the
// shape is generic so future posts only need to add an entry to POSTS.

import Link from "next/link"
import SupportChatConnected from "@/components/SupportChatConnected"
import { BLOG_POSTS, formatPostDate } from "@/lib/blog/posts"

export const dynamic = "force-static"
export const revalidate = 86400

export const metadata = {
  title: "Blog",
  alternates: {
    canonical: "https://www.rippackscity.com/blog",
    // RSS autodiscovery (<link rel="alternate" type="application/rss+xml">), 2026-10-11.
    types: { "application/rss+xml": "https://www.rippackscity.com/feed.xml" },
  },
  description:
    "Data-driven analysis of Flow blockchain collectibles: NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike.",
}

// POSTS lives in lib/blog/posts.ts since 2026-10-11 — shared with each post's
// BlogPosting JSON-LD + og:article dates and with app/feed.xml/route.ts.
const POSTS = BLOG_POSTS

const PAGE: React.CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "48px 20px 72px",
  color: "var(--rpc-text-primary)",
  fontFamily: "var(--font-mono)",
}

const H1: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 900,
  fontSize: 40,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--rpc-text-primary)",
  margin: "0 0 8px",
}

const SUBTITLE: React.CSSProperties = {
  margin: "0 0 40px",
  color: "var(--rpc-text-secondary)",
  fontSize: 14,
  lineHeight: 1.6,
}

const POST_CARD: React.CSSProperties = {
  display: "block",
  padding: "20px 22px",
  background: "var(--rpc-surface-raised)",
  border: "1px solid var(--rpc-border)",
  borderRadius: 8,
  marginBottom: 14,
  textDecoration: "none",
  color: "inherit",
  transition: "border-color 120ms ease",
}

const META: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "var(--rpc-red-text)",
  fontWeight: 700,
  marginBottom: 8,
}

const TITLE: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 800,
  fontSize: 22,
  letterSpacing: "0.02em",
  color: "var(--rpc-text-primary)",
  margin: "0 0 8px",
  lineHeight: 1.2,
}

const BLURB: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  color: "var(--rpc-text-secondary)",
  margin: 0,
}

export default function BlogIndex() {
  return (
    <>
    <main style={PAGE}>
      <h1 style={H1}>Field Notes</h1>
      <p style={SUBTITLE}>
        Long-form analysis from inside the platform. Numbers pulled live from
        Supabase at write-time, never recycled.
      </p>
      {POSTS.map((p) => (
        <Link key={p.slug} href={`/blog/${p.slug}`} style={POST_CARD}>
          <div style={META}>
            {p.collection} · {formatPostDate(p.date)} · {p.readMin} min read
          </div>
          <h2 style={TITLE}>{p.title}</h2>
          <p style={BLURB}>{p.blurb}</p>
        </Link>
      ))}
    </main>
      {/* Concierge, added 2026-09-02 with the /insights + home mounts: this is a
          public entry point a stranger lands on and it had no way to ask a
          question. No sub-layout here carries the launcher, so there is no
          double-mount. Revert: delete this line and the import. */}
      <SupportChatConnected />
    </>
  )
}
