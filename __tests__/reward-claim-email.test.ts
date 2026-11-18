import { describe, it, expect } from "vitest"
import { buildRewardClaimHtml, buildRewardClaimSubject, buildRewardClaimText, rewardClaimUrl } from "@/lib/emails/reward-claim-email"
import { SENDER_LINE } from "@/lib/emails/sender-identity"

const opts = { username: "knotbean", challengeTitle: "Dame Time", dropTitle: "Dame Time Challenge Reward Pack", dropSlug: "dame-time-challenge-reward-pack" }

describe("reward-claim email (2026-11-15)", () => {
  it("names the challenge and links the claim page", () => {
    expect(buildRewardClaimSubject(opts)).toBe("Your Dame Time reward pack is waiting")
    expect(buildRewardClaimText(opts)).toContain("https://www.rippackscity.com/giveaways/dame-time-challenge-reward-pack")
    expect(buildRewardClaimHtml(opts)).toContain('href="https://www.rippackscity.com/giveaways/dame-time-challenge-reward-pack?utm_source=email')
  })
  it("carries the sender line and sells nothing", () => {
    const all = buildRewardClaimText(opts) + buildRewardClaimHtml(opts)
    expect(all).toContain(SENDER_LINE.split(" · ")[0])
    expect(all).not.toMatch(/\b(buy|upgrade|pro plan|subscribe|most accurate|team captain)\b/i)
  })
  it("escapes a hostile username and refuses a slug that is not a slug", () => {
    expect(buildRewardClaimHtml({ ...opts, username: "<b>x</b>" })).not.toContain("<b>x</b>")
    expect(() => rewardClaimUrl("../admin")).toThrow(/bad drop slug/)
  })
})
