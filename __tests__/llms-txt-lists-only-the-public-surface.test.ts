import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isPublicPath } from "@/proxy"
import { INSIGHT_ROUTES } from "@/lib/sitemap-data"

// ─────────────────────────────────────────────────────────────────────────────
// public/llms.txt is the answer-engine index (robots deliberately admits AI
// crawlers — Trevor, 2026-08-01), so what it lists is what an LLM will cite.
//
// Until 2026-10-11 it pointed crawlers at /analytics/** (auth-gated), listed
// `/{collection}/analytics` for every collection, and omitted every /insights
// board, Candy, Panini, /market and the entity pages (review §3 E6). Nothing
// checked it, because it is a static file. This does, against the two sources
// of truth the file is supposed to mirror:
//
//   • proxy.ts `isPublicPath` — every path the file names must be anon-readable
//     (placeholders like <slug> are substituted so the shape itself is tested);
//   • lib/sitemap-data.ts `INSIGHT_ROUTES` — every board the sitemap advertises
//     must be in the index too.
// ─────────────────────────────────────────────────────────────────────────────

const TEXT = readFileSync(join(process.cwd(), "public", "llms.txt"), "utf8")

/** Every site path mentioned in the file, with `<placeholder>` segments made concrete. */
export function pathsIn(text: string): string[] {
  const out = new Set<string>()
  // A path starts at a `/` that is not inside a word or a URL scheme (`https://`),
  // and runs over path characters incl. `<placeholder>` segments.
  const re = /(?<![\w:/])\/[A-Za-z0-9_\-.<>]+(?:\/[A-Za-z0-9_\-.<>]+)*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const raw = m[0].replace(/[.,;:)]+$/, "")
    if (raw === "/" || raw.length < 2) continue
    out.add(raw)
  }
  return [...out]
}

const concrete = (p: string) => p.replace(/<[^>]+>/g, "x")

describe("llms.txt names a real population", () => {
  it("extracts a non-trivial set of paths (not vacuous)", () => {
    const paths = pathsIn(TEXT)
    expect(paths.length).toBeGreaterThan(50)
    // Spot checks on the extractor: both ends of the shape vocabulary.
    expect(paths).toContain("/insights/squeeze")
    expect(paths).toContain("/<collection>/edition/<slug>")
    expect(paths).toContain("/pinnacle/moment/<id>")
  })

  it("the extractor does not mistake prose slashes or URL schemes for paths", () => {
    expect(pathsIn("24h/7d/30d and Candy Digital / Solana, https://www.rippackscity.com/x")).toEqual([])
  })

  it("the instrument can see a gated path (control)", () => {
    expect(isPublicPath("/dashboard", "GET")).toBe(false)
    expect(isPublicPath("/my-teams", "GET")).toBe(false)
    expect(isPublicPath("/nba-top-shot/badges", "GET")).toBe(false)
  })
})

describe("BAN: no path in llms.txt is auth-gated per proxy.ts isPublicPath", () => {
  it.each(pathsIn(TEXT))("%s is anon-public", (p) => {
    expect(isPublicPath(concrete(p), "GET"), `${p} → ${concrete(p)} is gated; an AI crawler following it lands on /login`).toBe(true)
  })

  it("the old gated pointers are gone by name", () => {
    // /analytics/** was here until 2026-10-25, when it was gated. It is anon-public
    // now (proxy.ts) and listed; the per-path isPublicPath check above still holds
    // every listed /analytics path to that, so a re-gate reds this file.
    expect(TEXT).toMatch(/^- \/analytics /m)
    expect(isPublicPath("/analytics", "GET")).toBe(true)
    expect(TEXT).not.toMatch(/\/dashboard\b/)
    // The wallet-paste Collection tab is a tool with no indexable content of its own.
    expect(TEXT).not.toMatch(/\/[a-z-]+\/collection\b/)
  })
})

describe("every /insights board the sitemap advertises is in the index", () => {
  it("INSIGHT_ROUTES is real", () => {
    expect(INSIGHT_ROUTES.length).toBeGreaterThan(25)
  })
  it.each([...INSIGHT_ROUTES])("/insights/%s is listed with a description", (slug) => {
    const line = TEXT.split("\n").find((l) => l.startsWith(`- /insights/${slug} `) || l.startsWith(`- /insights/${slug}\u00a0`))
    expect(line, `/insights/${slug} missing from public/llms.txt`).toBeDefined()
    // "with one-line descriptions from their metadata": a bare path is not an entry.
    expect(line!.replace(`- /insights/${slug}`, "").trim().length).toBeGreaterThan(30)
  })
  it("the hub, the methodology page and /about are listed", () => {
    for (const p of ["/insights", "/legal/fmv-methodology", "/about", "/market", "/feed.xml"]) {
      expect(pathsIn(TEXT), `${p} missing`).toContain(p)
    }
  })
})
