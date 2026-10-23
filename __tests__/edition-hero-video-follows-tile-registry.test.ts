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

  // 2026-10-22: the hero passed detail.video_url RAW while the grid tiles proxy it.
  // UFC clips are bare ipfs.io URLs and ipfs.io now sends Cross-Origin-Resource-Policy,
  // so the browser blocked the hero video on every UFC edition page swept (6/6) and
  // the 10-18 change above still rendered a still image there.
  it("the hero video goes through the same-origin IPFS proxy, like the tiles", () => {
    const line = SRC.split("\n").find((l) => l.includes("videoUrl={hasVideo"))
    expect(line, "hero videoUrl prop").toBeDefined()
    expect(line).toContain("proxyIpfsUrl(detail.video_url)")
    expect(line).not.toMatch(/videoUrl=\{hasVideo \? detail\.video_url/)
  })

  it("the registry covers the collections whose editions carry clips", () => {
    for (const slug of ["nba-top-shot", "nfl-all-day", "laliga-golazos", "ufc", "candy-mlb"]) {
      expect(isTileVideoEnabled(slug), slug).toBe(true)
    }
    expect(isTileVideoEnabled("disney-pinnacle")).toBe(false)
  })
})
