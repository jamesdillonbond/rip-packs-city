// 2026-11-10: a closed challenge board was a dead end ("This challenge has
// closed." and nothing else). Dame Time locked while its X post kept sending
// people there; one signed up from it and left 14 s later. The closed board now
// offers the next step for each kind of viewer.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { closedChallengeHref, closedChallengeLabel } from "@/app/trophy-challenges/[slug]/ChallengeBoardClient"

describe("closed challenge board", () => {
  it("sends a completed entrant to their own case", () => {
    expect(closedChallengeHref("signed-in", { username: "spitehouse", complete: true }, "dame-time")).toContain("spitehouse")
    expect(closedChallengeLabel("signed-in", true)).toBe("See your case")
  })
  it("sends any other signed-in viewer to their trophy case tab", () => {
    expect(closedChallengeHref("signed-in", null, "dame-time")).toBe("/dashboard?tab=trophy")
    expect(closedChallengeHref("signed-in", { username: "x", complete: false }, "dame-time")).toBe("/dashboard?tab=trophy")
    expect(closedChallengeLabel("signed-in", false)).toBe("Build your trophy case")
  })
  it("offers sign-up, returning to the trophy tab — never the closed challenge's entry link", () => {
    for (const v of ["signed-out", "unknown"] as const) {
      const href = closedChallengeHref(v, null, "dame-time")
      expect(href).toBe("/login?intent=signup&next=%2Fdashboard%3Ftab%3Dtrophy")
      expect(href).not.toContain("challenge=")
    }
    expect(closedChallengeLabel("signed-out", false)).toBe("Create a free account")
  })
  it("the closed branch renders the link, not only the notice", () => {
    const src = readFileSync(join(process.cwd(), "app", "trophy-challenges", "[slug]", "ChallengeBoardClient.tsx"), "utf8")
    const i = src.indexOf("data-rpc-challenge-closed")
    expect(i).toBeGreaterThan(0)
    expect(src.slice(i, i + 900)).toContain("closedChallengeHref(")
  })
})
