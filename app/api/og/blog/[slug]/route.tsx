// app/api/og/blog/[slug]/route.tsx
//
// Open Graph card for a blog post: 1200×630 PNG, TEXT ONLY — the post's
// collection, title and date from lib/blog/posts.ts, the brand eyebrow and the
// URL. Same shape and rules as app/api/og/insights/[slug] (read that header).
//
// WHY (2026-10-14): every post's og:image was its COLLECTION card
// (/api/og/collection?id=nba-top-shot), so a shared article unfurled as an ad
// for Top Shot rather than as the article. No data fetch, so the card cannot
// publish a stale number. An unknown slug is a 404, never a generic 200 PNG.

import { ImageResponse } from "next/og"
import { NextRequest, NextResponse } from "next/server"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"
import { FALLBACK_RED } from "@/lib/og/entity-card"
import { getBlogPost, formatPostDate } from "@/lib/blog/posts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params
  const post = getBlogPost(slug)
  if (!post) {
    return NextResponse.json({ ok: false, error: `no blog post "${slug}"` }, { status: 404 })
  }

  const fonts = await brandFonts()
  const fam = brandFamilies(fonts)

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#0D0D0D",
          color: "#F1F1F1",
          padding: 60,
          fontFamily: fam.display,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ fontSize: 18, letterSpacing: 6, color: FALLBACK_RED, textTransform: "uppercase", display: "flex" }}>
            RIP PACKS CITY · FIELD NOTES
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex", fontFamily: fam.mono }}>
            {post.collection} · {formatPostDate(post.date)}
          </div>
        </div>

        <div
          style={{
            marginTop: 40,
            fontSize: post.title.length > 60 ? 58 : 72,
            fontWeight: 900,
            letterSpacing: 1,
            lineHeight: 1.04,
            display: "flex",
            textTransform: "uppercase",
            maxWidth: 1080,
          }}
        >
          {post.title}
        </div>

        <div style={{ flex: 1 }} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 18,
            color: "rgba(255,255,255,0.55)",
            borderTop: `3px solid ${FALLBACK_RED}`,
            paddingTop: 20,
            fontFamily: fam.mono,
          }}
        >
          <div style={{ display: "flex" }}>{post.readMin} min read</div>
          <div style={{ display: "flex" }}>rippackscity.com/blog/{post.slug}</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS },
  )
}
