import { describe, it, expect } from "vitest"
import { caseFoldedPath } from "@/proxy"
import { publishedCollections } from "@/lib/collections"

// proxy.ts caseFoldedPath (2026-11-06): a mixed-case collection / hub URL answers
// 308 to its lowercase page instead of 404. Measured live before the change:
// /NBA-Top-Shot/overview 404, /nba-top-shot/player/Jamal-Murray 404,
// /nba-top-shot/set/2025-NBA-Playoffs-Common 404, /nba-top-shot/team/Denver-Nuggets 404.

describe("caseFoldedPath", () => {
  it.each([
    ["/NBA-Top-Shot/overview", "/nba-top-shot/overview"],
    ["/nba-top-shot/Player/Jamal-Murray", "/nba-top-shot/player/jamal-murray"],
    ["/nba-top-shot/set/2025-NBA-Playoffs-Common", "/nba-top-shot/set/2025-nba-playoffs-common"],
    ["/nba-top-shot/team/Denver-Nuggets", "/nba-top-shot/team/denver-nuggets"],
    ["/disney-pinnacle/character/Mickey-Mouse", "/disney-pinnacle/character/mickey-mouse"],
    ["/nba-top-shot/pack/dist/8454A", "/nba-top-shot/pack/dist/8454a"],
    ["/Players/Jamal-Murray", "/players/jamal-murray"],
    ["/teams/NBA/Nuggets", "/teams/nba/nuggets"],
    ["/UFC/overview", "/ufc/overview"],
  ])("%s → %s", (from, to) => {
    expect(caseFoldedPath(from)).toBe(to)
  })

  it("never folds an EDITION slug — UFC keys are uppercase by construction", () => {
    expect(caseFoldedPath("/ufc/edition/DIEGO-FERREIRA-UFC-FIGHT-NIGHT-MAY-20-2023-KO-TKO-750")).toBeNull()
    // the tab segment still folds, the key does not
    expect(caseFoldedPath("/UFC/Edition/DIEGO-FERREIRA-750")).toBe("/ufc/edition/DIEGO-FERREIRA-750")
  })

  it.each([
    "/share/5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Solana address, case-sensitive
    "/moment/0xAbC",
    "/api/search?q=Murray",
    "/login?next=%2FNBA",
    "/insights/Squeeze",
    "/nba-top-shot/overview", // already lowercase — no redirect, no loop
    "/",
  ])("leaves %s alone", (p) => {
    expect(caseFoldedPath(p)).toBeNull()
  })

  it("a folded path never contains an uppercase letter outside an edition key (loop safety)", () => {
    for (const p of ["/NBA-Top-Shot/Player/X-Y", "/Teams/NBA/Nuggets", "/Players/A-B"]) {
      const folded = caseFoldedPath(p)!
      expect(folded).not.toMatch(/[A-Z]/)
      expect(caseFoldedPath(folded)).toBeNull()
    }
  })

  it("the literal root set covers every published collection's url slug (the proxy cannot import the registry)", () => {
    for (const c of publishedCollections()) {
      expect(caseFoldedPath(`/${c.id.toUpperCase()}/overview`), c.id).toBe(`/${c.id}/overview`)
    }
  })
})
