import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"
import robots from "@/app/robots"

// Pins for the 2026-09-06 Search Console pass. Three findings, three properties:
//
//   1. robots.txt blocked `/_next/` wholesale, so Googlebot could not fetch the
//      JS/CSS a page needs to RENDER (1,449 chunk URLs in "Blocked by
//      robots.txt"). The hashed static chunks and the image optimizer must be
//      allowed; the rest of /_next/ stays blocked.
//   2. /moment/<edition uuid> is the edition page under another URL. It carried
//      a canonical to the edition page and Google still crawled ~11,000 of them
//      into the not-indexed buckets. The EDITION-grain form now 301s; the
//      SERIAL-grain form (the shareable URL) must keep rendering.
//   3. /profile/<address> does not exist (the route resolves RPC usernames
//      only), and every buyer/seller/owner cell linked to it — 302 "Not found"
//      + 865 noindex profile URLs. No component may build that href from an
//      address again.
//
// Source-level where the property lives in a server component (the moment page
// is not unit-renderable here); a real call for robots(), which is pure.

const ROOT = path.resolve(__dirname, "..")
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8")

describe("robots: Googlebot may fetch the assets a page needs to render", () => {
  const rules = robots().rules
  const wildcard = (Array.isArray(rules) ? rules : [rules]).find((r) => r.userAgent === "*")!

  it("allows /_next/static/ and /_next/image explicitly", () => {
    const allow = ([] as string[]).concat(wildcard.allow ?? [])
    expect(allow).toContain("/_next/static/")
    expect(allow).toContain("/_next/image")
  })

  it("still blocks the rest of /_next/ and the API (the allow is a carve-out, not a removal)", () => {
    const disallow = ([] as string[]).concat(wildcard.disallow ?? [])
    expect(disallow).toContain("/_next/")
    expect(disallow).toContain("/api/")
  })
})

describe("/moment/<id>: the edition-grain duplicate redirects, the serial-grain page stays", () => {
  const src = read("app/moment/[id]/page.tsx")
  const layout = read("app/moment/[id]/layout.tsx")

  it("decides the redirect in the LAYOUT, before the first flush (the page's copy is a 200 + meta refresh)", () => {
    // Measured live on fd65daa: with loading.tsx in this segment, a
    // permanentRedirect in the page produced HTTP 200 with a streamed
    // NEXT_REDIRECT row and <meta http-equiv="refresh"> — no Location header,
    // so Google records no 301. The layout is awaited before the shell goes
    // out (the same reason the segment's 404 lives there).
    expect(layout).toMatch(/import \{[^}]*permanentRedirect[^}]*\} from "next\/navigation"/)
    expect(layout).toContain("editionGrainRedirectTarget(id, resolution)")
    expect(layout).toMatch(/if \(target\) permanentRedirect\(target\)/)
    // …and it is decided AFTER the 404 gate, never before it.
    expect(layout.indexOf("if (!resolves) notFound()")).toBeLessThan(layout.indexOf("permanentRedirect(target)"))
  })

  it("permanently redirects an edition-grain resolution to its canonical edition page", () => {
    expect(src).toMatch(/import \{[^}]*permanentRedirect[^}]*\} from "next\/navigation"/)
    // The redirect is gated on the resolver's OWN verdict that this is an edition
    // (not a serial-specific moment), and on the canonical differing from self.
    const i = src.indexOf('detail.resolved?.kind === "edition"')
    expect(i).toBeGreaterThan(0)
    const window = src.slice(i, i + 700)
    expect(window).toContain("momentCanonicalPath(")
    expect(window).toContain("permanentRedirect(target)")
    expect(window).toMatch(/if \(target !== `\/moment\/\$\{encodeURIComponent\(id\)\}`\)/)
  })

  it("does NOT redirect the serial-grain form (kind === 'moment' has no permanentRedirect path)", () => {
    // Every permanentRedirect call in the file sits inside the edition-kind guard.
    const calls = [...src.matchAll(/permanentRedirect\(/g)].map((m) => m.index!)
    expect(calls.length).toBe(1)
    const guard = src.indexOf('detail.resolved?.kind === "edition"')
    expect(calls[0]).toBeGreaterThan(guard)
    expect(calls[0] - guard).toBeLessThan(700)
  })
})

describe("no wallet cell links to /profile/<address> (a URL that does not exist)", () => {
  const files = [
    "components/entity/_shared.tsx",
    "components/entity/EditionActivity.tsx",
    "components/entity/SalesTablePaginated.tsx",
    "app/moment/[id]/page.tsx",
  ]
  for (const f of files) {
    it(`${f} builds no /profile/\${…address…} href`, () => {
      const src = read(f)
      // The property, not the spelling: no template literal that puts a
      // lowercased address after /profile/.
      expect(src).not.toMatch(/href=\{`\/profile\/\$\{lower\}`\}/)
      expect(src).not.toMatch(/\/profile\/\$\{(?:lower|address|addr)\b/)
    })
  }

  it("the wallet cells route to the wallet analyzer with rel=nofollow instead", () => {
    for (const f of files) {
      const src = read(f)
      expect(src).toContain("/collection?wallet=${lower}")
      expect(src).toContain('rel="nofollow"')
    }
  })
})

describe("/pricing is no longer advertised (2026-09-07, Trevor: 'take /pricing out of the footer')", () => {
  it("the footer has no /pricing link", () => {
    const src = read("components/SiteFooter.tsx")
    expect(src).not.toMatch(/href="\/pricing"/)
  })
  it("the pricing page is noindex (it says the product is free; it answers no search)", () => {
    const src = read("app/pricing/page.tsx")
    expect(src).toMatch(/robots:\s*\{\s*index:\s*false/)
  })
})
