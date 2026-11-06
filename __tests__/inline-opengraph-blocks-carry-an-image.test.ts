import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { objectLiterals } from "./helpers/object-literals"

// BAN: an inline `openGraph: { ...OG_INHERITED, … }` literal under app/** that
// carries NO `images` entry (and does not spread ROOT_OG_CONTENT, which has one).
//
// ── THE TRAP ───────────────────────────────────────────────────────────────
// `OG_INHERITED` carries type / locale / siteName — the fields the sibling guard
// (metadata-inline-blocks-inherit-root-fields) demands. `og:image` lives in
// ROOT_OG_CONTENT instead, so a page that spreads OG_INHERITED and restates its
// own title/description passes that guard while REPLACING the root block and
// losing the image. The rendered page then unfurls with `twitter:image` (still
// inherited — `twitter` is a separate top-level key) and NO `og:image`, which is
// what Slack, Discord, iMessage and LinkedIn read.
//
// Found live 2026-10-14 on /about (fixed there and on /help with an explicit
// `images:`), then found AGAIN 2026-11-06 on /market, /sniper, /privacy, /terms
// and /early-access by a 373-page curl sweep (`og:image` absent on exactly those
// five). Two sightings of one shape is a population, so this walks the tree.
//
// Scope is deliberately the SPREAD shape only: a block that restates
// `type/locale/siteName` by hand is already the sibling guard's business, and a
// block built by a lib/ helper computes its image from arguments this scanner
// cannot see — the three shared helpers are pinned elsewhere.

const ROOT = join(process.cwd(), "app")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p)
  }
  return out
}

export function blockCarriesImage(body: string): boolean {
  if (/\.\.\.\s*ROOT_OG_CONTENT\b/.test(body)) return true
  return /(^|[\s{,])images\s*:/.test(body)
}

export function scanSource(src: string): { spreadBlocks: number; bare: number } {
  let spreadBlocks = 0
  let bare = 0
  for (const body of objectLiterals(src, "openGraph")) {
    if (!/\.\.\.\s*OG_INHERITED\b/.test(body)) continue
    spreadBlocks++
    if (!blockCarriesImage(body)) bare++
  }
  return { spreadBlocks, bare }
}

function scan(): { hits: string[]; spreadBlocks: number } {
  const hits: string[] = []
  let spreadBlocks = 0
  for (const full of walk(ROOT)) {
    const src = readFileSync(full, "utf8")
    const r = scanSource(src)
    spreadBlocks += r.spreadBlocks
    if (r.bare) hits.push(relative(process.cwd(), full).split(sep).join("/"))
  }
  return { hits, spreadBlocks }
}

describe("every inline openGraph block that spreads OG_INHERITED carries an og:image", () => {
  it("the walk still finds the spread-shape population (not vacuously passing)", () => {
    // Measured 2026-11-06: 18 app/** files spread OG_INHERITED into an inline
    // openGraph literal. The floor sits well under so ordinary churn stays green
    // while a walker that stopped seeing the tree reds.
    expect(scan().spreadBlocks).toBeGreaterThan(10)
  })

  it("no spread-shape block is missing images", () => {
    const { hits } = scan()
    expect(
      hits.join("\n"),
      "these openGraph blocks REPLACE the root block and drop og:image — add an " +
        "`images:` entry (/api/og/default is the site card) or spread ROOT_OG_CONTENT:\n" + hits.join("\n"),
    ).toBe("")
  })

  // ── guards-the-guard: planted defects, pinned as SOURCE not file path ────

  it("flags the exact pre-fix /market block", () => {
    const preFix = [
      "export function generateMetadata(): Metadata {",
      "  return {",
      '    title: "Market — Collectibles Sales & Volume by Collection",',
      "    openGraph: {",
      "      ...OG_INHERITED,",
      '      title: "Market — Rip Packs City",',
      '      description: "Sales and volume by collection, and the week\'s biggest sales.",',
      "    },",
      "  }",
      "}",
    ].join("\n")
    expect(scanSource(preFix)).toEqual({ spreadBlocks: 1, bare: 1 })
  })

  it("accepts an explicit images entry, a ROOT_OG_CONTENT spread, and a block that does not spread OG_INHERITED", () => {
    const explicit = 'openGraph: { ...OG_INHERITED, title: "x", images: [{ url: "https://x/og" }] }'
    expect(scanSource(explicit)).toEqual({ spreadBlocks: 1, bare: 0 })
    const rootSpread = 'openGraph: { ...OG_INHERITED, ...ROOT_OG_CONTENT, url: "/" }'
    expect(scanSource(rootSpread)).toEqual({ spreadBlocks: 1, bare: 0 })
    const helperBuilt = 'openGraph: { type: "website", title: "x", images }'
    expect(scanSource(helperBuilt)).toEqual({ spreadBlocks: 0, bare: 0 })
    // `images` inside a quoted alt string must not count as the field.
    const quoted = 'openGraph: { ...OG_INHERITED, title: "images: none", description: "d" }'
    expect(scanSource(quoted)).toEqual({ spreadBlocks: 1, bare: 1 })
  })
})
