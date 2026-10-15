// lib/routing/known-top-level.ts is an AUTH BOUNDARY: a signed-out request whose first
// segment is NOT in it skips the sign-in gate (so Next can render its 404). A new
// top-level route missing from the list would therefore be served without the gate.
// This derives the set from `app/` itself — route groups flattened, dynamic and private
// segments excluded, metadata route files mapped to their URLs — and reds on ANY
// difference in either direction. It also pins the one assumption the pass-through
// relies on: the only top-level dynamic segment is `[collection]`, whose layout
// notFound()s an unknown slug.

import { describe, it, expect } from "vitest"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { STATIC_TOP_LEVEL_SEGMENTS, isRoutableFirstSegment, firstSegment } from "@/lib/routing/known-top-level"

const APP = join(process.cwd(), "app")
// Metadata/route files at the app root that answer a URL (Next file conventions).
const ROOT_FILE_ROUTES: Record<string, string> = { "robots.ts": "robots.txt", "sitemap.ts": "sitemap.xml", "manifest.ts": "manifest.webmanifest" }

function derive(dir: string, segs: Set<string>, dynamic: string[]) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name.startsWith("(")) derive(full, segs, dynamic) // route group: its children are top-level
      else if (name.startsWith("[")) dynamic.push(name)
      else if (name.startsWith("_") || name.startsWith("@")) continue // private folder / parallel slot
      else segs.add(name)
    } else if (dir === APP && ROOT_FILE_ROUTES[name]) {
      segs.add(ROOT_FILE_ROUTES[name])
    }
  }
}

describe("STATIC_TOP_LEVEL_SEGMENTS is exactly the app tree's top level", () => {
  const segs = new Set<string>(["_next"])
  const dynamic: string[] = []
  derive(APP, segs, dynamic)

  it("inspected a real tree (positive control)", () => {
    expect(segs.size).toBeGreaterThan(20)
    expect(segs.has("dashboard")).toBe(true)
  })

  it("every routed segment is in the list (a missing one would skip the sign-in gate)", () => {
    const missing = [...segs].filter((s) => !STATIC_TOP_LEVEL_SEGMENTS.has(s)).sort()
    expect(missing).toEqual([])
  })

  it("every listed segment is still routed (no dead entries)", () => {
    const extra = [...STATIC_TOP_LEVEL_SEGMENTS].filter((s) => !segs.has(s)).sort()
    expect(extra).toEqual([])
  })

  it("the only top-level dynamic segment is [collection]", () => {
    expect(dynamic).toEqual(["[collection]"])
  })
})

describe("isRoutableFirstSegment", () => {
  it("root, static routes and collection slugs are routable", () => {
    for (const p of ["/", "/dashboard/watchlist", "/insights", "/nba-top-shot/sniper", "/candy-mlb", "/robots.txt"]) {
      expect(isRoutableFirstSegment(p)).toBe(true)
    }
  })
  it("an unknown first segment is not", () => {
    for (const p of ["/this-page-does-not-exist", "/wp-admin/setup.php", "/nba-topshot/sniper"]) {
      expect(isRoutableFirstSegment(p)).toBe(false)
    }
  })
  it("firstSegment strips leading slashes", () => {
    expect(firstSegment("//a/b")).toBe("a")
    expect(firstSegment("/")).toBe("")
  })
})
