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
  // deep-audit R35 - <lastmod> REMOVED rather than corrected.
  //
  // It was `new Date().toISOString()`, so every child carried an identical
  // timestamp equal to the moment the index was generated. That is not when the
  // child's URL set last changed, and because this route is force-static with a
  // 6h revalidate it moved every 6h whether anything changed or not. Google
  // explicitly discounts a lastmod that always reads "now", so the tag was
  // simultaneously false and useless.
  //
  // <lastmod> is OPTIONAL in the sitemap protocol. Omitting it asserts nothing;
  // publishing a generation timestamp asserts something we cannot substantiate.
  // Same rule as everywhere else here: do not publish a number you cannot stand
  // behind just because the field exists.
  //
  // ⚠ Do NOT "fix" this by bucketing the timestamp to the revalidate window -
  // that is still a claim that the content changed at time T, only coarser. A
  // real lastmod needs a max(updated_at) across each segment's data sources,
  // which this force-static route cannot afford; if that is ever wanted, it
  // belongs in the child routes that actually know their own inputs.
  const entries = SEGMENT_IDS.map(
    (id) => `  <sitemap>\n    <loc>${BASE_URL}/sitemap/${id}.xml</loc>\n  </sitemap>`,
  ).join("\n")
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`
  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=3600",
    },
  })
}
