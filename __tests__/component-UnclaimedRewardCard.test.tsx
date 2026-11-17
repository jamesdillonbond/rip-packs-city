// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

const { track } = vi.hoisted(() => ({ track: vi.fn() }))
vi.mock("@/lib/telemetry/track", () => ({ track: (...a: unknown[]) => track(...a) }))
import UnclaimedRewardCard, { rewardsFromBody } from "@/components/profile/UnclaimedRewardCard"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  track.mockReset()
})

const REWARD = { rewards: [{ drop: { slug: "dt", title: "Dame Time Challenge Reward Pack" }, challenge: { slug: "dame-time", title: "Dame Time" }, packsLeft: 6 }] }
const answer = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as unknown as Response)

// 2026-11-15: the dashboard card for an earned, unclaimed challenge reward pack.
describe("rewardsFromBody", () => {
  it("reads the rewards from one ok answer", () => {
    expect(rewardsFromBody(REWARD)).toEqual([{ dropSlug: "dt", dropTitle: "Dame Time Challenge Reward Pack", challengeTitle: "Dame Time" }])
  })
  it("a failed read (null / error body / malformed rows) renders no card — never a claim about the account", () => {
    expect(rewardsFromBody(null)).toEqual([])
    expect(rewardsFromBody({ error: "Couldn't check your challenge rewards." })).toEqual([])
    expect(rewardsFromBody({ rewards: [{ drop: { slug: "dt" } }] })).toEqual([])
  })
})

// 2026-11-16: the card also renders on the Packs tab, and every event says which surface
describe("UnclaimedRewardCard", () => {
  it("on the Packs tab: shows the card, links to the claim page, and tags shown/click with surface=packs", async () => {
    vi.stubGlobal("fetch", answer(200, REWARD))
    render(<UnclaimedRewardCard surface="packs" />)
    const link = await screen.findByRole("link", { name: /Claim your pack/ })
    expect(link.getAttribute("href")).toBe("/giveaways/dt")
    expect(screen.getByText(/Your Dame Time reward pack is waiting/)).toBeTruthy()
    expect(track).toHaveBeenCalledWith("reward-claim-card-shown", { drops: "dt", surface: "packs" })
    fireEvent.click(link)
    expect(track).toHaveBeenCalledWith("reward-claim-card-click", { drop: "dt", surface: "packs" })
  })

  it("defaults to the Overview surface", async () => {
    vi.stubGlobal("fetch", answer(200, REWARD))
    render(<UnclaimedRewardCard />)
    fireEvent.click(await screen.findByRole("link", { name: /Claim your pack/ }))
    expect(track).toHaveBeenCalledWith("reward-claim-card-click", { drop: "dt", surface: "overview" })
  })

  it("a failed read renders nothing and records nothing", async () => {
    const f = answer(503, { error: "unavailable" })
    vi.stubGlobal("fetch", f)
    const { container } = render(<UnclaimedRewardCard surface="packs" />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(container.textContent).toBe("")
    expect(track).not.toHaveBeenCalled()
  })
})

describe("dashboard wiring", () => {
  const src = readFileSync("app/dashboard/DashboardClient.tsx", "utf8")
  it("mounts the reward card on Overview", () => {
    expect(src).toMatch(/<UnclaimedRewardCard \/>/)
  })
  it("mounts the reward card on the Packs tab", () => {
    expect(readFileSync("app/dashboard/packs/PackHistoryClient.tsx", "utf8")).toMatch(/<UnclaimedRewardCard surface="packs" \/>/)
  })
  it("a member with no wallet saved sees only the add-wallet ask: the challenge and alert cards sit behind !heroFormShown", () => {
    expect(src).toMatch(/\{!heroFormShown && \(\s*<>\s*<ChallengeProgressNudge \/>\s*<FirstAlertPrompt \/>/)
  })
})
