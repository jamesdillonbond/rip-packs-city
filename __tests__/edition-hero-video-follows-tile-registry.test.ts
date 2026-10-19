import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { isTileVideoEnabled } from "@/lib/entity-editions-grid-format"

// 2026-10-18: the edition page decided hero video from a hand list (Top Shot,
// All Day, Candy, Panini) while the grid tiles read isTileVideoEnabled — so
// Golazos and UFC edition pages showed a still image for clips their own tiles
// play. The hero now resolves through the same registry.
const SRC = readFileSync("app/(collections)/[collection]/edition/[slug]/page.tsx", "utf8")

describe("edition hero video follows the tile-video registry", () => {
  it("hasVideo is derived from isTileVideoEnabled, not a literal slug list", () => {
    const line = SRC.split("\n").find((l) => l.includes("const hasVideo ="))
    expect(line, "hasVideo declaration").toBeDefined()
    expect(line).toContain("isTileVideoEnabled(collection)")
    expect(line).not.toMatch(/collection === "/)
  })

  it("the registry covers the collections whose editions carry clips", () => {
    for (const slug of ["nba-top-shot", "nfl-all-day", "laliga-golazos", "ufc", "candy-mlb"]) {
      expect(isTileVideoEnabled(slug), slug).toBe(true)
    }
    expect(isTileVideoEnabled("disney-pinnacle")).toBe(false)
  })
})
