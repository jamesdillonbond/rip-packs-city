// 2026-11-10: the Dame Time board had no way to its reward packs (Trevor: "apply
// everything needed to the dame time challenge, so that afterwards we can have users
// claim these packs"). When an open drop is tied to the challenge the board shows a
// banner; what it says depends on who is looking.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { rewardBanner } from "@/app/trophy-challenges/[slug]/ChallengeBoardClient"

const REWARD = { slug: "dame-time-challenge-reward-pack", title: "Dame Time Challenge Reward Pack" }

describe("challenge board reward banner", () => {
  it("tells a finisher the pack is theirs and goes straight to the claim page", () => {
    expect(rewardBanner("signed-in", true, "Dame Time", REWARD)).toEqual({
      text: "You completed Dame Time. Your reward pack is ready.",
      label: "Claim your pack",
      href: "/giveaways/dame-time-challenge-reward-pack",
    })
  })
  it("never tells anyone else a pack is theirs", () => {
    for (const [viewer, complete] of [["signed-in", false], ["unknown", false], ["unknown", true], ["signed-out", false], ["signed-out", true]] as const) {
      const b = rewardBanner(viewer, complete, "Dame Time", REWARD)
      expect(b.text).toBe("Reward packs are out for everyone who completed Dame Time.")
      expect(b.text).not.toContain("Your reward pack")
    }
  })
  it("sends a signed-out visitor through sign-in and back to the packs", () => {
    const b = rewardBanner("signed-out", false, "Dame Time", REWARD)
    expect(b.label).toBe("Sign in to claim yours")
    expect(b.href).toBe("/login?next=%2Fgiveaways%2Fdame-time-challenge-reward-pack")
    expect(rewardBanner("signed-in", false, "Dame Time", REWARD).href).toBe("/giveaways/dame-time-challenge-reward-pack")
  })
  it("the board renders the banner only when the route sent a reward", () => {
    const src = readFileSync(join(process.cwd(), "app", "trophy-challenges", "[slug]", "ChallengeBoardClient.tsx"), "utf8")
    const i = src.indexOf("{state.board.reward ? (")
    expect(i).toBeGreaterThan(0)
    expect(src.slice(i, i + 400)).toContain("rewardBanner(")
    expect(src).toContain("data-rpc-challenge-reward")
  })
})
