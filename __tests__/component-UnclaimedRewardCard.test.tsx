import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { rewardsFromBody } from "@/components/profile/UnclaimedRewardCard"

// 2026-11-15: the dashboard card for an earned, unclaimed challenge reward pack.
describe("rewardsFromBody", () => {
  it("reads the rewards from one ok answer", () => {
    expect(
      rewardsFromBody({ rewards: [{ drop: { slug: "dt", title: "Dame Time Challenge Reward Pack" }, challenge: { slug: "dame-time", title: "Dame Time" }, packsLeft: 6 }] }),
    ).toEqual([{ dropSlug: "dt", dropTitle: "Dame Time Challenge Reward Pack", challengeTitle: "Dame Time" }])
  })
  it("a failed read (null / error body / malformed rows) renders no card — never a claim about the account", () => {
    expect(rewardsFromBody(null)).toEqual([])
    expect(rewardsFromBody({ error: "Couldn't check your challenge rewards." })).toEqual([])
    expect(rewardsFromBody({ rewards: [{ drop: { slug: "dt" } }] })).toEqual([])
  })
})

describe("dashboard wiring", () => {
  const src = readFileSync("app/dashboard/DashboardClient.tsx", "utf8")
  it("mounts the reward card on Overview", () => {
    expect(src).toMatch(/<UnclaimedRewardCard \/>/)
  })
  it("a member with no wallet saved sees only the add-wallet ask: the challenge and alert cards sit behind !heroFormShown", () => {
    expect(src).toMatch(/\{!heroFormShown && \(\s*<>\s*<ChallengeProgressNudge \/>\s*<FirstAlertPrompt \/>/)
  })
})
