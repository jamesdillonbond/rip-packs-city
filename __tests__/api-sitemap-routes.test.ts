import { describe, it, expect, vi, afterEach } from "vitest"

// The two sitemap route handlers — /sitemap.xml (the <sitemapindex> at the
// GSC-registered URL) and /sitemap/<id>.xml (its five segment children).
//
// ⚠ These are `route.ts` files that live OUTSIDE app/api, so the primary
// coverage gate's old `app/api/**/route.ts` glob missed both and neither had a
// test. Route handlers are a FILE convention, not a directory one — the same
// blind-spot class as the `.ts` vs `.tsx` gap, landing here on the SEO surface.
//
// Why bytes matter more than status here: a sitemap failure is SILENT. The
// route still returns 200 with well-formed-looking XML, but if a single URL
// contains an unescaped `&`, the document is malformed and Google discards
// EVERY url in that segment — tens of thousands of pages quietly de-indexed,
// with no error anywhere in the stack. So these assertions parse the emitted
// XML rather than trusting the handler, and the escaping test uses the
// characters that actually appear in this app's URLs (query strings, slugs with
// apostrophes).

const REAL_SEGMENT_IDS = [0, 1, 2, 3, 4]

afterEach(() => {
  vi.resetModules()
  vi.doUnmock("@/lib/sitemap-data")
})

describe("/sitemap.xml — the sitemap index", () => {
  async function get() {
    const { GET } = await import("@/app/sitemap.xml/route")
    const res = await GET()
    return { res, xml: await res.text() }
  }

  it("emits a spec-compliant <sitemapindex> with the right content-type", async () => {
    const { res, xml } = await get()
    expect(res.status).toBe(200)
    // An XML sitemap served as text/html is ignored by crawlers.
    expect(res.headers.get("content-type")).toContain("application/xml")
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(xml.trimEnd().endsWith("</sitemapindex>")).toBe(true)
  })

  it("advertises EXACTLY the five segment children, each an absolute URL", async () => {
    const { xml } = await get()
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    expect(locs).toHaveLength(REAL_SEGMENT_IDS.length)
    for (const id of REAL_SEGMENT_IDS) {
      // A relative <loc> is invalid per the sitemap spec and is dropped
      // wholesale by Search Console.
      expect(locs.some((l) => /^https?:\/\//.test(l) && l.endsWith(`/sitemap/${id}.xml`))).toBe(true)
    }
  })

  it("stays in lockstep with the segment ids the child route actually serves", async () => {
    // The index and the children are declared in two different files. If they
    // drift, the index either advertises a 404 child or silently omits a real
    // one — both invisible until Search Console reports missing pages.
    const { SITEMAP_SEGMENT_IDS } = await import("@/lib/sitemap-data")
    const { xml } = await get()
    const advertised = [...xml.matchAll(/\/sitemap\/(\d+)\.xml/g)].map((m) => Number(m[1])).sort()
    expect(advertised).toEqual([...SITEMAP_SEGMENT_IDS].sort())
  })

  it("publishes NO <lastmod> rather than a generation timestamp", async () => {
    // ⚠ INVERTED from "gives every child a lastmod" (deep-audit R35).
    //
    // The old assertion pinned the DEFECT. The value was
    // `new Date().toISOString()`, so all five children carried an IDENTICAL
    // timestamp equal to the moment the index was generated - not when any
    // child's URL set actually changed - and it moved every 6h on the revalidate
    // whether anything changed or not. Google discounts a lastmod that always
    // reads "now", so the tag was both false and useless, and this test was
    // holding it in place.
    //
    // <lastmod> is optional in the sitemap protocol. Omitting it asserts
    // nothing; a generation timestamp asserts something unsubstantiated.
    const { xml } = await get()
    expect(xml).not.toContain("<lastmod>")

    // ...and the index must still be a valid, complete sitemapindex. Dropping
    // the tag must not have cost us the children.
    const advertised = [...xml.matchAll(/\/sitemap\/(\d+)\.xml/g)].map((m) => Number(m[1]))
    expect(advertised).toHaveLength(REAL_SEGMENT_IDS.length)
    expect(xml).toContain("<sitemapindex")
  })
})

describe("/sitemap/<id>.xml — the segment children", () => {
  function mockSegment(entries: unknown[]) {
    vi.doMock("@/lib/sitemap-data", () => ({
      SITEMAP_SEGMENT_IDS: REAL_SEGMENT_IDS,
      buildSitemapSegment: async () => entries,
    }))
  }

  async function get(id: string) {
    const { GET } = await import("@/app/sitemap/[id]/route")
    const res = await GET(new Request("https://www.rippackscity.com/sitemap/0.xml"), {
      params: Promise.resolve({ id }),
    })
    return { res, xml: await res.text() }
  }

  it("renders a <urlset> for a valid segment", async () => {
    mockSegment([
      {
        url: "https://www.rippackscity.com/nba-top-shot/overview",
        lastModified: new Date("2026-08-01T00:00:00Z"),
        changeFrequency: "daily",
        priority: 0.8,
      },
    ])
    const { res, xml } = await get("0.xml")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/xml")
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(xml).toContain("<loc>https://www.rippackscity.com/nba-top-shot/overview</loc>")
    expect(xml).toContain("<changefreq>daily</changefreq>")
    expect(xml).toContain("<priority>0.8</priority>")
  })

  it("XML-ESCAPES every url — one raw & invalidates the whole document", async () => {
    // This is the silent killer: the route returns 200 and the XML looks fine
    // to a human, but an unescaped ampersand makes it unparseable and Google
    // discards every URL in the segment.
    mockSegment([
      {
        url: "https://www.rippackscity.com/search?q=a&b=1&c=<2>&d='x'&e=\"y\"",
        lastModified: new Date("2026-08-01T00:00:00Z"),
      },
    ])
    const { xml } = await get("1.xml")
    const loc = xml.match(/<loc>([^<]*)<\/loc>/)?.[1] ?? ""
    expect(loc).toContain("&amp;")
    expect(loc).toContain("&lt;")
    expect(loc).toContain("&gt;")
    expect(loc).toContain("&apos;")
    expect(loc).toContain("&quot;")
    // No BARE ampersand may survive — `&amp;` is fine, a lone `&` is not.
    expect(/&(?!amp;|lt;|gt;|apos;|quot;)/.test(loc)).toBe(false)
  })

  it("omits changefreq/priority when the entry has none, rather than emitting empty tags", async () => {
    // An empty <priority></priority> is a validation error, not a no-op.
    mockSegment([{ url: "https://www.rippackscity.com/", lastModified: new Date() }])
    const { xml } = await get("2.xml")
    expect(xml).not.toContain("<changefreq>")
    expect(xml).not.toContain("<priority>")
    expect(xml).toContain("<lastmod>")
  })

  it("accepts a string or missing lastModified without emitting an invalid date", async () => {
    mockSegment([
      { url: "https://www.rippackscity.com/a", lastModified: "2026-08-01T00:00:00.000Z" },
      { url: "https://www.rippackscity.com/b" },
    ])
    const { xml } = await get("3.xml")
    const mods = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1])
    expect(mods).toHaveLength(2)
    // "Invalid Date" in a lastmod fails sitemap validation for the whole file.
    for (const m of mods) expect(Number.isNaN(Date.parse(m))).toBe(false)
  })

  it("renders an empty but VALID urlset when the segment has no entries", async () => {
    // An empty segment is a legitimate state; it must not produce malformed XML.
    mockSegment([])
    const { res, xml } = await get("4.xml")
    expect(res.status).toBe(200)
    expect(xml).toContain("<urlset")
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true)
  })

  describe("id validation — a bad id must 404, never render a wrong segment", () => {
    const BAD = [
      ["out of range", "9.xml"],
      ["negative", "-1.xml"],
      ["non-numeric", "abc.xml"],
      ["missing the .xml suffix", "0"],
      ["path traversal attempt", "../0.xml"],
      ["empty", ""],
    ]
    for (const [why, id] of BAD) {
      it(`404s on ${why} (${JSON.stringify(id)})`, async () => {
        mockSegment([{ url: "https://www.rippackscity.com/leak", lastModified: new Date() }])
        const { res, xml } = await get(id)
        expect(res.status).toBe(404)
        // The guard must run BEFORE the segment build — a 404 that still leaked
        // a urlset would mean the validation is cosmetic.
        expect(xml).not.toContain("<urlset")
      })
    }

    it("serves zero-padded ids as the same segment (documented, benign)", async () => {
      // `parseInt("00")` is 0 and /^\d+\.xml$/ allows the padding, so
      // /sitemap/00.xml renders segment 0. Recorded as ACTUAL behaviour rather
      // than asserted as a contract: nothing links it (the index emits only
      // 0-4), so no crawler reaches it, and tightening the regex would be a
      // change to live SEO routing for a URL that is never requested. If that
      // ever becomes reachable, this is the place to make it a 404.
      mockSegment([{ url: "https://www.rippackscity.com/x", lastModified: new Date() }])
      const { res } = await get("00.xml")
      expect(res.status).toBe(200)
    })

    it("accepts every id the index advertises", async () => {
      mockSegment([{ url: "https://www.rippackscity.com/x", lastModified: new Date() }])
      for (const id of REAL_SEGMENT_IDS) {
        const { res } = await get(`${id}.xml`)
        expect(res.status, `segment ${id} should be served`).toBe(200)
      }
    })
  })
})
