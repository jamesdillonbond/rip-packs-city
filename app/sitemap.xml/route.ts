// app/sitemap.xml/route.ts
//
// Sitemap INDEX at the GSC-registered URL. app/sitemap.ts now uses
// generateSitemaps(), which serves the actual URL sets as segment children at
// /sitemap/<id>.xml (0 static+insights+overviews+series+profiles, 1 Top Shot
// editions, 2 AllDay/Golazos/UFC editions, 3 entities+top-moments,
// 4 packs+Pinnacle pins) — but Next emits NO index file for them. This
// route keeps /sitemap.xml alive as a spec-compliant <sitemapindex> pointing
// at the five children, so Google Search Console's registered sitemap URL and
// robots.txt's single Sitemap: line both keep working with zero operator
// action. proxy.ts opens /sitemap.xml and /sitemap/<id>.xml to anon.

import { NextResponse } from "next/server"

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const SEGMENT_IDS = [0, 1, 2, 3, 4]

export const dynamic = "force-static"
export const revalidate = 21600 // match app/sitemap.ts

export async function GET(): Promise<NextResponse> {
  const lastmod = new Date().toISOString()
  const entries = SEGMENT_IDS.map(
    (id) => `  <sitemap>\n    <loc>${BASE_URL}/sitemap/${id}.xml</loc>\n    <lastmod>${lastmod}</lastmod>\n  </sitemap>`,
  ).join("\n")
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`
  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=3600",
    },
  })
}
