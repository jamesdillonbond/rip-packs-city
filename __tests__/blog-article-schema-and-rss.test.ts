import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { BLOG_POSTS, blogPostUrl, formatPostDate, getBlogPost } from "@/lib/blog/posts"
import { articleJsonLd, RPC_ORGANIZATION } from "@/lib/seo"
import { GET as feedGet, buildFeedXml } from "@/app/feed.xml/route"

// ─────────────────────────────────────────────────────────────────────────────
// Blog plumbing (review §3 E3): BlogPosting JSON-LD + og:article dates on both
// posts, one POSTS source, and an RSS 2.0 feed at app/feed.xml/route.ts that
// returns REAL XML BYTES (a status-only assertion passes a 200 with an empty body).
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()
const read = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"))

describe("lib/blog/posts.ts is the single source", () => {
  it("has the two posts with ISO dates and absolute images", () => {
    expect(BLOG_POSTS.length).toBeGreaterThanOrEqual(2)
    for (const p of BLOG_POSTS) {
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      if (p.dateModified) expect(p.dateModified >= p.date).toBe(true)
      expect(p.image).toMatch(/^https:\/\/www\.rippackscity\.com\//)
      expect(blogPostUrl(p)).toBe(`https://www.rippackscity.com/blog/${p.slug}`)
    }
  })
  it("formats the display date the way the pages always showed it", () => {
    expect(formatPostDate("2026-06-09")).toBe("June 9, 2026")
    expect(formatPostDate("2026-05-07")).toBe("May 7, 2026")
  })
  it("the index no longer carries its own copy of POSTS", () => {
    const src = read("app/blog/page.tsx")
    expect(src).toContain("BLOG_POSTS")
    expect(src).not.toMatch(/date:\s*["']June 9, 2026["']/)
  })
  it.each(BLOG_POSTS.map((p) => p.slug))("app/blog/%s/page.tsx reads its record, emits BlogPosting and og:article dates", (slug) => {
    const src = read(`app/blog/${slug}/page.tsx`)
    expect(src).toContain(`getBlogPost("${slug}")`)
    expect(src).toContain("articleJsonLd(")
    expect(src).toMatch(/type="application\/ld\+json"/)
    expect(src).toMatch(/publishedTime:\s*POST\.date/)
    expect(src).toMatch(/type:\s*"article"/)
  })
})

describe("articleJsonLd", () => {
  it("emits a BlogPosting whose author + publisher are the Organization", () => {
    const post = getBlogPost("permanent-moments-ipfs")!
    const ld = articleJsonLd({
      headline: post.title,
      description: post.blurb,
      datePublished: post.date,
      dateModified: post.dateModified,
      url: blogPostUrl(post),
      image: post.image,
    }) as Record<string, any>
    expect(ld["@context"]).toBe("https://schema.org")
    expect(ld["@type"]).toBe("BlogPosting")
    expect(ld.headline).toBe(post.title)
    expect(ld.datePublished).toBe("2026-06-09")
    expect(ld.dateModified).toBe("2026-06-10")
    expect(ld.url).toBe("https://www.rippackscity.com/blog/permanent-moments-ipfs")
    expect(ld.mainEntityOfPage).toEqual({ "@type": "WebPage", "@id": ld.url })
    expect(ld.image).toEqual([post.image])
    expect(ld.author).toEqual(RPC_ORGANIZATION)
    expect(ld.publisher).toEqual(RPC_ORGANIZATION)
    expect(ld.author["@type"]).toBe("Organization")
  })
  it("dateModified falls back to datePublished, never to now()", () => {
    const ld = articleJsonLd({ headline: "x", description: "y", datePublished: "2026-05-07", url: "https://www.rippackscity.com/blog/z" })
    expect(ld.dateModified).toBe("2026-05-07")
    expect(ld).not.toHaveProperty("image")
  })
})

describe("app/feed.xml/route.ts — RSS 2.0 with real bytes", () => {
  it("GET returns application/rss+xml, a shared cache and a parseable RSS document", async () => {
    const res = await feedGet()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8")
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=\d+/)
    const buf = Buffer.from(await res.arrayBuffer())
    // Real bytes: the 0-byte-200 trap.
    expect(buf.length).toBeGreaterThan(500)
    const xml = buf.toString("utf8")
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toMatch(/<rss version="2\.0"/)
    expect(xml).toMatch(/<channel>[\s\S]*<\/channel>\s*<\/rss>\s*$/)
    expect(xml).toContain("<link>https://www.rippackscity.com/blog</link>")
    expect(xml).toContain('<atom:link href="https://www.rippackscity.com/feed.xml" rel="self" type="application/rss+xml" />')
  })

  it("every post is an <item> with an absolute link, a permalink guid and an RFC 822 pubDate", () => {
    const xml = buildFeedXml()
    expect((xml.match(/<item>/g) ?? []).length).toBe(BLOG_POSTS.length)
    for (const p of BLOG_POSTS) {
      expect(xml).toContain(`<link>https://www.rippackscity.com/blog/${p.slug}</link>`)
      expect(xml).toContain(`<guid isPermaLink="true">https://www.rippackscity.com/blog/${p.slug}</guid>`)
      const expected = new Date(`${p.date}T00:00:00Z`).toUTCString()
      expect(expected).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} 00:00:00 GMT$/)
      expect(xml).toContain(`<pubDate>${expected}</pubDate>`)
    }
    // Newest first.
    const links = [...xml.matchAll(/<guid isPermaLink="true">([^<]+)<\/guid>/g)].map((m) => m[1])
    expect(links[0]).toBe("https://www.rippackscity.com/blog/permanent-moments-ipfs")
  })

  it("escapes XML-significant characters in titles (the apostrophe post survives a parser)", () => {
    const xml = buildFeedXml()
    expect(xml).not.toMatch(/<title>[^<]*&(?!amp;|lt;|gt;|quot;|#)/)
    expect(xml).toContain("Here&apos;s".replace("&apos;", "'")) // apostrophes are legal in element text
  })

  it("the blog index advertises the feed for autodiscovery", () => {
    const src = read("app/blog/page.tsx")
    expect(src).toMatch(/"application\/rss\+xml":\s*"https:\/\/www\.rippackscity\.com\/feed\.xml"/)
  })
})
