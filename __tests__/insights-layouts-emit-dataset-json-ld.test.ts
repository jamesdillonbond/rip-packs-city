import { describe, it, expect } from "vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { INSIGHTS_BOARDS, getInsightsBoard } from "@/lib/insights/board-registry"
import { insightsBoardJsonLd, insightsDatasetJsonLd, organizationEntityJsonLd, RPC_ORGANIZATION } from "@/lib/seo"

// ─────────────────────────────────────────────────────────────────────────────
// Structured data where Google can SEE it (platform review 2026-10-11, §3 E1).
//
// Before this: every `Dataset` node on the estate (14) lived under
// app/(analytics)/** — auth-gated and unlisted — while the 32 anon-public
// /insights boards emitted either nothing or a copy-pasted WebApplication with
// a `$0 Offer` that described the ROOT app, not the board. This pins the fix:
//
//   1. every app/insights/<slug>/layout.tsx emits the shared helper FOR ITS OWN
//      SLUG (a tree walk, not a list — a new board that forgets reds here);
//   2. the registry and the directory agree in BOTH directions;
//   3. a dataset board renders a schema.org Dataset with a `distribution` iff
//      its public JSON route exists on disk; a wallet tool renders a
//      WebApplication (a "paste your wallet" lookup is not a dataset);
//   4. no layout spells its own JSON-LD object any more (the drift vector);
//   5. the Dataset population under app/insights is real, not vacuous, and
//      app/(analytics) is no longer the ONLY tree that emits one;
//   6. /about carries a top-level Organization with logo + sameAs.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()
const INSIGHTS_DIR = join(ROOT, "app", "insights")
const PUBLIC_API_DIR = join(ROOT, "app", "api", "public", "insights")

const boardDirs = readdirSync(INSIGHTS_DIR).filter((d) => statSync(join(INSIGHTS_DIR, d)).isDirectory())
const read = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"))

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walkTsx(p, out)
    else if (p.endsWith(".tsx")) out.push(p)
  }
  return out
}

describe("the population is real", () => {
  it("finds the board directories and the registry has the same cardinality", () => {
    expect(boardDirs.length).toBeGreaterThan(25)
    expect(INSIGHTS_BOARDS.length).toBe(boardDirs.length)
  })

  it("registry slugs == app/insights/<slug> directories, both directions", () => {
    const registry = INSIGHTS_BOARDS.map((b) => b.slug).sort()
    expect(registry).toEqual([...boardDirs].sort())
  })

  it("registry slugs are unique", () => {
    expect(new Set(INSIGHTS_BOARDS.map((b) => b.slug)).size).toBe(INSIGHTS_BOARDS.length)
  })
})

describe("every anon-public insights layout emits the shared JSON-LD helper for ITS OWN slug", () => {
  it.each(boardDirs)("app/insights/%s/layout.tsx", (slug) => {
    const src = read(`app/insights/${slug}/layout.tsx`)
    // The call must name THIS directory — a copy-pasted sibling slug would emit
    // another board's Dataset on this URL, which is a false claim in machine-
    // readable form.
    expect(src).toContain(`insightsBoardJsonLd("${slug}")`)
    expect(src).toMatch(/type="application\/ld\+json"/)
    // No second, hand-spelled node beside it.
    expect(src, "a layout must not spell its own JSON-LD object").not.toMatch(/["']@context["']\s*:/)
    expect(src, "the per-board $0 Offer boilerplate is gone from the layouts").not.toMatch(/priceCurrency/)
  })
})

describe("the node each board renders", () => {
  const datasets = INSIGHTS_BOARDS.filter((b) => b.kind === "dataset")
  const tools = INSIGHTS_BOARDS.filter((b) => b.kind === "tool")

  it("there are both kinds, so each branch below is exercised", () => {
    expect(datasets.length).toBeGreaterThan(20)
    expect(tools.length).toBeGreaterThan(0)
  })

  it.each(datasets.map((b) => b.slug))("%s → schema.org Dataset with name, description, url, creator", (slug) => {
    const ld = insightsBoardJsonLd(slug) as Record<string, any>
    expect(ld["@context"]).toBe("https://schema.org")
    expect(ld["@type"]).toBe("Dataset")
    expect(ld.name.length).toBeGreaterThan(3)
    // Google's Dataset guidance: a description of 50+ characters.
    expect(ld.description.length).toBeGreaterThanOrEqual(50)
    expect(ld.url).toBe(`https://www.rippackscity.com/insights/${slug}`)
    expect(ld.creator).toEqual(RPC_ORGANIZATION)
    expect(ld.publisher).toEqual(RPC_ORGANIZATION)
    expect(ld.isAccessibleForFree).toBe(true)
    expect(ld).not.toHaveProperty("offers")
  })

  it.each(datasets.map((b) => b.slug))(
    "%s carries a `distribution` iff app/api/public/insights/<slug>/route.ts exists",
    (slug) => {
      const routeOnDisk = existsSync(join(PUBLIC_API_DIR, slug, "route.ts"))
      const board = getInsightsBoard(slug)!
      expect(board.publicApi, `registry publicApi for ${slug} disagrees with the directory`).toBe(routeOnDisk)
      const ld = insightsBoardJsonLd(slug) as Record<string, any>
      if (routeOnDisk) {
        expect(ld.distribution).toEqual([
          {
            "@type": "DataDownload",
            encodingFormat: "application/json",
            contentUrl: `https://www.rippackscity.com/api/public/insights/${slug}`,
          },
        ])
      } else {
        expect(ld).not.toHaveProperty("distribution")
      }
    },
  )

  it.each(tools.map((b) => b.slug))("%s (wallet tool) → WebApplication, never a Dataset", (slug) => {
    const ld = insightsBoardJsonLd(slug) as Record<string, any>
    expect(ld["@type"]).toBe("WebApplication")
    expect(ld.url).toBe(`https://www.rippackscity.com/insights/${slug}`)
    expect(ld.publisher).toEqual(RPC_ORGANIZATION)
    // A tool's public route (if any) takes a required ?wallet= — not a download.
    expect(getInsightsBoard(slug)!.publicApi).toBe(false)
  })

  it("an unknown slug THROWS rather than emitting nothing", () => {
    expect(() => insightsBoardJsonLd("not-a-board")).toThrow(/board-registry/)
  })

  it("the Dataset builder omits temporalCoverage (rolling windows cannot be a dated claim)", () => {
    for (const b of datasets) expect(insightsDatasetJsonLd(b)).not.toHaveProperty("temporalCoverage")
  })
})

describe("Dataset schema is emitted on anon-public insights layouts and NOT only under app/(analytics)", () => {
  it("app/(analytics) still emits Dataset nodes (control: the old-only location is real)", () => {
    const analytics = walkTsx(join(ROOT, "app", "(analytics)"))
      .map((f) => readFileSync(f, "utf8"))
      .filter((s) => /["']@type["']\s*:\s*["']Dataset["']/.test(s))
    expect(analytics.length).toBeGreaterThan(0)
  })

  it("the anon-public /insights tree renders MORE Dataset nodes than the gated analytics tree", () => {
    const analytics = walkTsx(join(ROOT, "app", "(analytics)"))
      .map((f) => readFileSync(f, "utf8"))
      .filter((s) => /["']@type["']\s*:\s*["']Dataset["']/.test(s)).length
    // Rendered through the helper, so counted by rendering, not by grepping a
    // literal the layouts no longer contain.
    const insights = boardDirs.filter((slug) => (insightsBoardJsonLd(slug) as any)["@type"] === "Dataset").length
    expect(insights).toBeGreaterThan(analytics)
    expect(insights).toBeGreaterThan(20)
  })
})

describe("/about carries the Organization entity", () => {
  it("the node has logo (absolute) + sameAs (the X account) and the page emits it", () => {
    expect(organizationEntityJsonLd["@type"]).toBe("Organization")
    expect(organizationEntityJsonLd.name).toBe("Rip Packs City")
    expect(organizationEntityJsonLd.url).toBe("https://www.rippackscity.com")
    expect(organizationEntityJsonLd.logo).toBe("https://www.rippackscity.com/rip-packs-city-logo.png")
    expect(existsSync(join(ROOT, "public", "rip-packs-city-logo.png")), "the logo the node points at exists").toBe(true)
    expect(organizationEntityJsonLd.sameAs).toContain("https://x.com/RipPacksCity")
    const about = read("app/about/page.tsx")
    expect(about).toContain("organizationEntityJsonLd")
    expect(about).toMatch(/type="application\/ld\+json"/)
  })
})
