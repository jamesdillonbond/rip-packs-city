import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// DEFECT REGRESSION (2026-07-25): pack "What's Inside" spun on
// "Loading pack contents…" forever in production.
//
// Verified before fixing: the DB is fast (`get_pack_contents` = 24 rows / 67 ms on
// TS dist 1599, ≤731 ms across the 40 largest pools) and a full curl of the live
// page returns the completely rendered section, its hidden `<div id="S:1">`
// payload and the trailing `$RC("B:1","S:1")` script in ~1.1 s. The browser simply
// never performed the swap: `document.readyState` "complete", the real markup left
// inert inside `div[hidden]`, no console error, no Sentry event.
//
// A watchdog inside the Suspense fallback CANNOT rescue this, which is the
// non-obvious part and the reason this guard is structural rather than behavioural:
// React does not hydrate the fallback of a dehydrated Suspense boundary. Measured
// in the live page — the fallback <section> carried ZERO `__reactFiber$` keys while
// a sibling section carried them — so no client component placed in a fallback ever
// mounts while the boundary is pending, and no timer there can ever fire.
//
// So the contract this pins is: the pack contents read happens in the SHELL, the
// grid is NOT inside the bottom Suspense boundary, and that boundary does not
// render a spinner fallback. Reintroducing any of those restores the defect.
const SRC = readFileSync(
  join(process.cwd(), "app/(collections)/[collection]/pack/dist/[distId]/page.tsx"),
  "utf8",
)

describe("pack dist page — What's Inside must not depend on stream completion", () => {
  it("reads pack contents in the shell, not inside the streamed group", () => {
    const streamed = SRC.slice(SRC.indexOf("async function PackStreamedBottom"))
    expect(streamed).not.toContain("fetchPackContents(")
    // The shell awaits it.
    const shell = SRC.slice(
      SRC.indexOf("export default async function PackDetailPage"),
      SRC.indexOf("async function PackStreamedBottom"),
    )
    expect(shell).toContain("fetchPackContents(coll.id, distId, PACK_CONTENTS_PAGE_SIZE, 0)")
  })

  it("renders the grid via PackContentsSection outside the streamed boundary", () => {
    const section = SRC.indexOf("<PackContentsSection")
    const streamedChild = SRC.indexOf("<PackStreamedBottom")
    expect(section).toBeGreaterThan(-1)
    expect(streamedChild).toBeGreaterThan(-1)
    // Emitted before the streamed child, so it cannot be inside that boundary.
    expect(section).toBeLessThan(streamedChild)
    // And the boundary wrapping PackStreamedBottom carries a null fallback.
    const before = SRC.slice(section, streamedChild)
    expect(before).toContain("<Suspense fallback={null}>")
  })

  it("never gives the bottom boundary a text fallback (the infinite spinner)", () => {
    // Strip comments — the fix is documented in prose that mentions the old label.
    const code = SRC.split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n")
    expect(code).not.toContain("Loading pack contents")
    expect(code).not.toContain("PackSectionSkeleton")
  })

  it("distinguishes a failed contents read (null) from an empty pool ([])", () => {
    // fetchPackContents must signal failure as null, so the panel can say so
    // rather than silently vanishing.
    expect(SRC).toContain("Promise<EditionTile[] | null>")
    const sec = SRC.slice(SRC.indexOf("function PackContentsSection"))
    expect(sec).toContain("contents === null")
    expect(sec).toContain("Couldn&apos;t load this pack&apos;s contents")
    expect(sec).toContain("contents.length === 0")
  })

  it("keeps the grid fed by the same public route its Load-more uses", () => {
    const sec = SRC.slice(SRC.indexOf("function PackContentsSection"))
    expect(sec).toContain("/api/entity/pack?collection=")
  })
})
