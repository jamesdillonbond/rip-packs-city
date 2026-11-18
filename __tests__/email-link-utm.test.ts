import { describe, expect, it } from "vitest"
import { emailLink } from "@/lib/emails/email-link"
import { buildRewardClaimHtml, buildRewardClaimText } from "@/lib/emails/reward-claim-email"

describe("emailLink — campaign tags on email links (2026-11-17)", () => {
  it("tags an own-site link with source, medium and campaign", () => {
    const u = new URL(emailLink("https://www.rippackscity.com/dashboard", "weekly_digest", "dashboard"))
    expect(u.searchParams.get("utm_source")).toBe("email")
    expect(u.searchParams.get("utm_medium")).toBe("weekly_digest")
    expect(u.searchParams.get("utm_campaign")).toBe("dashboard")
    expect(u.pathname).toBe("/dashboard")
  })

  it("keeps an existing query string and never double-tags", () => {
    const once = emailLink("https://www.rippackscity.com/x?a=1", "m", "c")
    expect(new URL(once).searchParams.get("a")).toBe("1")
    expect(emailLink(once, "other", "other")).toBe(once)
  })

  it("leaves a link to another site untouched", () => {
    const ext = "https://nbatopshot.com/listings/p2p/abc"
    expect(emailLink(ext, "m", "c")).toBe(ext)
  })

  it("leaves a non-URL untouched instead of throwing", () => {
    expect(emailLink("not a url", "m", "c")).toBe("not a url")
  })

  it("the reward-claim email's claim link carries the tag in both parts", () => {
    const opts = { dropSlug: "dame-time-challenge-reward-pack", challengeTitle: "Dame Time", dropTitle: "Reward Pack", username: "x" }
    expect(buildRewardClaimHtml(opts)).toContain("utm_source=email&amp;utm_medium=reward_claim")
    expect(buildRewardClaimText(opts)).toContain("utm_source=email&utm_medium=reward_claim")
  })
})
