import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Guard for the Panini runner's DOM card-image enumeration (method "b"), added
// 2026-07-27. scripts/ingest-panini-runner.mjs is a RESIDENTIAL Playwright
// script that CI cannot run (it needs a logged-in Chrome), so the enumeration
// robustness it provides has no behavioural coverage. This pins BOTH:
//
//   1. the psku-extraction CONTRACT — from a card <img> src, recover only the
//      full 4-field psku (packcard-<setId>_<parallelSetId>_<cardId>_<playerId>),
//      scoped to the WC prefix, so a thumbnail that embeds a truncated base key
//      can never pollute the detail-page walk with a non-resolving psku; and
//   2. that the live runner still USES exactly that regex + selector + prefix
//      filter (a source-drift guard, the same mechanism the edge-fn tests use) —
//      so a future edit that loosens the match trips this test instead of
//      silently re-introducing walk-budget pollution.
//
// The mirror below is intentionally byte-equivalent to the runner's inner loop;
// the drift guard keeps them honest.

const RUNNER_PATH = join(process.cwd(), "scripts", "ingest-panini-runner.mjs")
const WC_PREFIX = "packcard-2332_"

// Byte-equivalent mirror of scripts/ingest-panini-runner.mjs::harvestDomPskus's
// per-src extraction (regex + prefix gate). Returns the psku or null.
function extractWcPsku(src: string, prefix = WC_PREFIX): string | null {
  const m = src.match(/packcard-[0-9]+_[0-9]+_[0-9]+_[0-9]+/)
  if (!m) return null
  const psku = m[0]
  return psku.startsWith(prefix) ? psku : null
}

describe("panini-runner DOM psku extraction (method b)", () => {
  it("extracts the full 4-field psku from a plain card image URL", () => {
    expect(extractWcPsku("https://cdn.x/img/packcard-2332_486964_12579093_31.png")).toBe(
      "packcard-2332_486964_12579093_31",
    )
  })

  it("stops at the 4th field through a thumbnail suffix + query params", () => {
    expect(
      extractWcPsku("https://cdn.x/packcard-2332_486964_12579093_31_thumb.webp?v=3"),
    ).toBe("packcard-2332_486964_12579093_31")
  })

  it("takes the FIRST four fields when the URL carries a 5th numeric segment", () => {
    expect(extractWcPsku("https://cdn.x/packcard-2332_486964_12579093_31_2.png")).toBe(
      "packcard-2332_486964_12579093_31",
    )
  })

  it("REJECTS a truncated base key (fewer than 4 fields) — never pollutes the walk", () => {
    expect(extractWcPsku("https://cdn.x/packcard-2332_12579093.png")).toBeNull()
    expect(extractWcPsku("https://cdn.x/packcard-2332.png")).toBeNull()
  })

  it("REJECTS a full psku from a different product set (prefix gate)", () => {
    // Well-formed 4-field psku, wrong setId ⇒ filtered out by WC_PREFIX.
    expect(extractWcPsku("https://cdn.x/packcard-9999_1_2_3.png")).toBeNull()
  })

  it("REJECTS a non-card image", () => {
    expect(extractWcPsku("https://cdn.x/logo.png")).toBeNull()
    expect(extractWcPsku("")).toBeNull()
  })
})

describe("panini-runner source-drift guard", () => {
  const src = readFileSync(RUNNER_PATH, "utf8")

  it("still scrapes card images via the img[src*=\"packcard-\"] selector", () => {
    expect(src).toContain('querySelectorAll(\'img[src*="packcard-"]\')')
  })

  it("still requires the FULL 4-field psku regex (not a loose packcard-<digits> match)", () => {
    // If this fails, harvestDomPskus was edited. Re-verify the extraction
    // contract above and update the mirror + this literal together.
    expect(src).toContain("/packcard-[0-9]+_[0-9]+_[0-9]+_[0-9]+/")
  })

  it("still gates harvested pskus by WC_PREFIX before adding them to the walk set", () => {
    expect(src).toMatch(/psku\.startsWith\(WC_PREFIX\)[\s\S]*enumPskus\.add\(psku\)/)
  })
})
