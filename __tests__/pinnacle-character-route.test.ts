// 2026-10-31 (Trevor: "refer to Pinnacle assets as characters"). Disney Pinnacle's player
// pages live at /disney-pinnacle/character/<slug>; every other collection keeps /player/.
// Pins: the helper, the 308 from the old Pinnacle URL (and NO redirect for other
// collections), the route files, and the proxy treating /character/ as a public entity page.
import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { playerPagePath, playerSegment } from "@/lib/player-route"
import { buildSearchHref } from "@/lib/search/href"
import { momentSubjectHref } from "@/lib/entity-href"

describe("Pinnacle character URLs", () => {
  it("playerPagePath: character for Pinnacle, player everywhere else", () => {
    expect(playerPagePath("disney-pinnacle", "goofy")).toBe("/disney-pinnacle/character/goofy")
    expect(playerSegment("nba-top-shot")).toBe("player")
    for (const c of ["nba-top-shot", "nfl-all-day", "laliga-golazos", "ufc", "candy-mlb", "panini-blockchain"]) {
      expect(playerPagePath(c, "a-b")).toBe(`/${c}/player/a-b`)
    }
  })
  it("search and moment-subject links use /character/ for Pinnacle only", () => {
    expect(buildSearchHref("player", "disney-pinnacle", "mickey-mouse")).toBe("/disney-pinnacle/character/mickey-mouse")
    expect(buildSearchHref("player", "nba-top-shot", "lebron-james")).toBe("/nba-top-shot/player/lebron-james")
    expect(momentSubjectHref("disney-pinnacle", "Goofy", null)).toBe("/disney-pinnacle/character/goofy")
    expect(momentSubjectHref("nba-top-shot", "LeBron James", "Los Angeles Lakers")).toBe("/nba-top-shot/player/lebron-james")
  })
  it("next.config 308s the old Pinnacle /player/ URL, and only Pinnacle's", () => {
    const cfg = readFileSync("next.config.ts", "utf8")
    expect(cfg).toMatch(/source: "\/disney-pinnacle\/player\/:slug",\s*destination: "\/disney-pinnacle\/character\/:slug",\s*permanent: true/)
    expect(cfg).not.toMatch(/source: "\/:collection\/player\/:slug"/)
  })
  it("the character route reuses the player page and gate (no fork)", () => {
    const dir = "app/(collections)/[collection]/character/[slug]"
    for (const f of ["page.tsx", "layout.tsx", "loading.tsx"]) expect(existsSync(`${dir}/${f}`)).toBe(true)
    expect(readFileSync(`${dir}/page.tsx`, "utf8")).toMatch(/from "\.\.\/\.\.\/player\/\[slug\]\/page"/)
    expect(readFileSync(`${dir}/layout.tsx`, "utf8")).toMatch(/permanentRedirect\(`\/\$\{collection\}\/player\//)
  })
  it("the proxy serves /<collection>/character/<slug> anonymously, like /player/", () => {
    const proxy = readFileSync("proxy.ts", "utf8")
    expect(proxy).toMatch(/\(\?:edition\|set\|player\|character\|team/)
  })
})
