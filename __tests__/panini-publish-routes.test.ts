// Every collection TAB route Panini does not ship redirects to its overview.
//
// WHY: Panini renders the SHARED app/(collections)/[collection]/* pages. A tab
// route Panini lacks (badges, play, fast-break, …) would otherwise render a Flow
// surface under a Panini URL. proxy.ts's RETIRED_COLLECTION_TABS sends each one
// to /overview. Its header has claimed since 2026-09-25 that THIS file pins
// "every tab Panini lacks is here" — but the file did not exist until
// 2026-10-14, so that half of the property was enforced by nothing. The other
// half (no entry names a tab the collection ships) is
// __tests__/ufc-sniper-is-retired.test.ts.
//
// ⚠ THE POPULATION IS A TREE WALK, not a curated list: every directory under
// app/(collections)/[collection]/ that has its own page.tsx is a tab route. A
// new tab dir added later is checked without anyone remembering this file.
// Entity routes (edition/[slug], player/[slug], …) have no page.tsx at their
// own level and are a different surface, so they fall out by construction.

import { describe, it, expect } from "vitest"
import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { getCollection } from "@/lib/collections"

const ROOT = join(process.cwd(), "app", "(collections)", "[collection]")
const PANINI = "panini-blockchain"

function tabRouteDirs(): string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, "page.tsx")))
    .map((d) => d.name)
}

describe("Panini's missing tabs are retired in proxy.ts", () => {
  it("the walk finds the tab routes (non-vacuous)", () => {
    const tabs = tabRouteDirs()
    // overview is shipped by every collection; if the walk cannot see it, it sees nothing.
    expect(tabs).toContain("overview")
    expect(tabs.length).toBeGreaterThan(5)
  })

  it("every tab route Panini does not ship is in RETIRED_COLLECTION_TABS", async () => {
    const panini = getCollection(PANINI)
    expect(panini, "panini-blockchain missing from the registry").toBeTruthy()
    expect(panini!.published, "this pin is meaningless if Panini is unpublished").toBe(true)
    const { RETIRED_COLLECTION_TABS } = await import("@/proxy")
    const shipped = new Set<string>(panini!.pages)
    // 2026-10-25: /product (the products index) is Panini's own surface, switched on by the registry's
    // `productPages` — not a Flow tab it lacks. Any collection without the switch 404s there (the page checks it).
    if (panini!.productPages) shipped.add("product")
    const missing = tabRouteDirs().filter((t) => !shipped.has(t))
    // Non-vacuous: Panini lacks several Flow-only tabs today (badges, play, …).
    expect(missing.length).toBeGreaterThan(0)
    const unretired = missing.filter((t) => !RETIRED_COLLECTION_TABS.has(`${PANINI}/${t}`))
    expect(unretired, "tab routes Panini lacks that would render a Flow surface under a Panini URL").toEqual([])
  })

  it("no retired Panini entry names a tab Panini ships", async () => {
    const panini = getCollection(PANINI)!
    const { RETIRED_COLLECTION_TABS } = await import("@/proxy")
    const retired = [...RETIRED_COLLECTION_TABS]
      .filter((p) => p.startsWith(`${PANINI}/`))
      .map((p) => p.slice(PANINI.length + 1))
    expect(retired.length).toBeGreaterThan(0)
    expect(retired.filter((t) => (panini.pages as string[]).includes(t))).toEqual([])
  })
})
