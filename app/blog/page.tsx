// app/blog/page.tsx
//
// Minimal blog index. Lists published long-form pieces in reverse-chronological
// order. Currently a one-entry list — Pinnacle Star Wars Day 2026 — but the
// shape is generic so future posts only need to add an entry to POSTS.

import Link from "next/link"

export const dynamic = "force-static"
export const revalidate = 86400

export const metadata = {
  title: "Blog — Rip Packs City",
  description:
    "Data-driven analysis of Flow blockchain collectibles: NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike.",
}

interface BlogPost {
  slug: string
  title: string
  date: string
  collection: string
  blurb: string
  readMin: number
}

const POSTS: BlogPost[] = [
  {
    slug: "permanent-moments-ipfs",
    title: "Your Moments Just Became Permanent. Here's What That Actually Means.",
    date: "June 9, 2026",
    collection: "NBA Top Shot",
    blurb:
      "Top Shot just pinned every Moment's video to IPFS. What content-addressing actually guarantees, how to verify a Moment yourself in 30 seconds, and what we built with the data.",
    readMin: 6,
  },
  {
    slug: "pinnacle-star-wars-day-2026",
    title: "Star Wars Day 2026 on Disney Pinnacle: What's Actually Moving",
    date: "May 7, 2026",
    collection: "Disney Pinnacle",
    blurb:
      "53 editions, 14 sets, 408 historical sales. Where the Mandalorian peak buyers are now underwater, the only edition trading below FMV with HIGH confidence, and what we still don't know.",
    readMin: 8,
  },
]

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
  color: "var(--rpc-red, #E03A2F)",
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
    <main style={PAGE}>
      <h1 style={H1}>Field Notes</h1>
      <p style={SUBTITLE}>
        Long-form analysis from inside the platform. Numbers pulled live from
        Supabase at write-time, never recycled.
      </p>
      {POSTS.map((p) => (
        <Link key={p.slug} href={`/blog/${p.slug}`} style={POST_CARD}>
          <div style={META}>
            {p.collection} · {p.date} · {p.readMin} min read
          </div>
          <h2 style={TITLE}>{p.title}</h2>
          <p style={BLURB}>{p.blurb}</p>
        </Link>
      ))}
    </main>
  )
}
