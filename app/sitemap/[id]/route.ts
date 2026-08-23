// app/sitemap/[id]/route.ts
//
// Serves the sitemap segment children the /sitemap.xml index advertises:
// /sitemap/0.xml … /sitemap/4.xml. The URL data lives in lib/sitemap-data.ts
// (buildSitemapSegment); this handler just renders spec-compliant <urlset>
// XML. Hand-rolled because Next's metadata sitemap convention claims
// /sitemap.xml even when generateSitemaps() is used, which conflicts with the
// index route handler (see app/sitemap.xml/route.ts). proxy.ts opens
// /sitemap/<id>.xml to anon.

import { NextResponse } from "next/server"
import { buildSitemapSegment, SitemapReadIncomplete, SITEMAP_SEGMENT_IDS } from "@/lib/sitemap-data"

export const dynamic = "force-dynamic"
export const revalidate = 21600 // 6h, matching the old app/sitemap.ts

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;")
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: rawId } = await ctx.params
  const id = parseInt(rawId.replace(/\.xml$/, ""), 10)
  if (!Number.isInteger(id) || !SITEMAP_SEGMENT_IDS.includes(id) || !/^\d+\.xml$/.test(rawId)) {
    return new NextResponse("Not Found", { status: 404 })
  }

  // ⚠ 503, NEVER A PARTIAL 200 (R47 / known-issues #28). A sitemap is a claim
  // about which URLs EXIST, so serving the rows we happened to get says the rest
  // are gone — measured: segment 3 built its whole set/player/team universe from
  // 24,000 of 27,121 editions after a statement timeout, under a 200. A 5xx is
  // the honest answer: a crawler retries it and keeps the sitemap it already
  // has, which is the outcome a truncated 200 destroys.
  //
  // ⚠ NOT 404 and NOT an empty <urlset> — both are affirmative statements. 404
  // contradicts the index that advertises this segment; an empty urlset says the
  // site has no pages of this kind.
  let entries
  try {
    entries = await buildSitemapSegment(id)
  } catch (e) {
    const partial = e instanceof SitemapReadIncomplete
    console.log(`[sitemap] segment ${id} unavailable (${partial ? "incomplete read" : "unexpected"}): ${e instanceof Error ? e.message : String(e)}`)
    return new NextResponse("Sitemap segment temporarily unavailable", {
      status: 503,
      headers: {
        "Retry-After": "3600",
        // ⚠ Must not be cached: the next request should be able to succeed.
        "Cache-Control": "no-store",
      },
    })
  }
  const body = entries
    .map((e) => {
      const lastmod =
        e.lastModified instanceof Date
          ? e.lastModified.toISOString()
          : typeof e.lastModified === "string"
            ? e.lastModified
            : new Date().toISOString()
      const freq = e.changeFrequency ? `\n    <changefreq>${e.changeFrequency}</changefreq>` : ""
      const prio = typeof e.priority === "number" ? `\n    <priority>${e.priority}</priority>` : ""
      return `  <url>\n    <loc>${esc(e.url)}</loc>\n    <lastmod>${lastmod}</lastmod>${freq}${prio}\n  </url>`
    })
    .join("\n")
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=3600",
    },
  })
}
