// app/feed.xml/route.ts
//
// RSS 2.0 for /blog, built from lib/blog/posts.ts (review §3 E3). Static input,
// no DB read, so there is no failure branch to render honestly — a post is in
// the feed iff it is in BLOG_POSTS. Public in proxy.ts (exact path); linked from
// the blog index via `alternates.types["application/rss+xml"]`.

import { NextResponse } from "next/server"
import { BLOG_POSTS, blogPostUrl } from "@/lib/blog/posts"

export const revalidate = 86400

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** RFC 822 date at 00:00 UTC on the ISO day — what <pubDate> requires. */
function rfc822(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toUTCString()
}

export function buildFeedXml(): string {
  const posts = [...BLOG_POSTS].sort((a, b) => (a.date < b.date ? 1 : -1))
  const items = posts
    .map(
      (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${blogPostUrl(p)}</link>
      <guid isPermaLink="true">${blogPostUrl(p)}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <category>${esc(p.collection)}</category>
      <description>${esc(p.blurb)}</description>
    </item>`,
    )
    .join("\n")
  const newest = posts[0]?.date
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Rip Packs City — Field Notes</title>
    <link>${BASE_URL}/blog</link>
    <atom:link href="${BASE_URL}/feed.xml" rel="self" type="application/rss+xml" />
    <description>Data-driven analysis of Flow blockchain collectibles: NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike.</description>
    <language>en-us</language>
${newest ? `    <lastBuildDate>${rfc822(newest)}</lastBuildDate>\n` : ""}${items}
  </channel>
</rss>
`
}

export async function GET() {
  return new NextResponse(buildFeedXml(), {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
    },
  })
}
