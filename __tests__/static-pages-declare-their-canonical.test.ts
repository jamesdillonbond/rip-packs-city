// 2026-09-25 — a served-HTML sweep of 898 sitemap URLs found NINE indexable
// 200s with no <link rel="canonical">: /about, /privacy, /terms, /blog, the two
// blog posts, /legal/fmv-methodology, and the two bespoke Pinnacle tabs
// (/disney-pinnacle/collection and /sniper — which also shared ONE generic
// <title>, "Disney Pinnacle Analytics — Rip Packs City", inherited from their
// segment layout). Every other surface carries a self-canonical. This pins the
// static pages by source and the two Pinnacle tabs by their metadata builder.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const read = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), "utf8"))

const STATIC: Array<[string, string]> = [
  ["app/about/page.tsx", "https://www.rippackscity.com/about"],
  ["app/privacy/page.tsx", "https://www.rippackscity.com/privacy"],
  ["app/terms/page.tsx", "https://www.rippackscity.com/terms"],
  ["app/blog/page.tsx", "https://www.rippackscity.com/blog"],
  ["app/blog/permanent-moments-ipfs/page.tsx", "https://www.rippackscity.com/blog/permanent-moments-ipfs"],
  ["app/blog/pinnacle-star-wars-day-2026/page.tsx", "https://www.rippackscity.com/blog/pinnacle-star-wars-day-2026"],
  ["app/legal/fmv-methodology/page.tsx", "https://www.rippackscity.com/legal/fmv-methodology"],
]

describe("static pages declare their own self-canonical", () => {
  it.each(STATIC)("%s → %s", (file, canonical) => {
    const src = read(file)
    expect(src).toMatch(new RegExp(`alternates:\\s*\\{\\s*canonical:\\s*["'\`]${canonical.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["'\`]\\s*\\}`))
  })
})

describe("the bespoke Pinnacle tabs carry their own title and canonical", () => {
  it.each(["collection", "sniper"])("disney-pinnacle/%s builds its metadata through pageMetadata", async (tab) => {
    const src = read(`app/(collections)/disney-pinnacle/${tab}/page.tsx`)
    expect(src).toMatch(/export function generateMetadata\(\)/)
    expect(src).toMatch(new RegExp(`pageMetadata\\("${tab}",`))
    const mod = await import(`@/app/(collections)/disney-pinnacle/${tab}/page`)
    const m = mod.generateMetadata() as { alternates?: { canonical?: string }; title?: unknown }
    expect(m.alternates?.canonical).toBe(`https://www.rippackscity.com/disney-pinnacle/${tab}`)
    // Not the segment layout's generic title — the tab's own.
    expect(String(m.title)).not.toMatch(/Disney Pinnacle Analytics — Rip Packs City/)
  })
  it("the two tabs no longer share a title", async () => {
    const a = (await import("@/app/(collections)/disney-pinnacle/collection/page")).generateMetadata()
    const b = (await import("@/app/(collections)/disney-pinnacle/sniper/page")).generateMetadata()
    expect(String(a.title)).not.toBe(String(b.title))
  })
})
