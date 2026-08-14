// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import ShareProfileButtons from "@/components/profile/ShareProfileButtons"

// ─────────────────────────────────────────────────────────────────────────────
// The tweet a collector is handed when they hit "Share on X".
//
// It read "My NBA Top Shot collection on @RipPacksCity" for EVERY collector, on
// a platform covering five Flow collections — so an All Day or Pinnacle
// collector's own share copy misdescribed their holdings, in a post going out
// under their name. It also never mentioned the trophy case, which is what the
// attached card actually leads with.
// ─────────────────────────────────────────────────────────────────────────────

let opened: string | null = null

beforeEach(() => {
  opened = null
  vi.stubGlobal("open", vi.fn((url: string) => { opened = url }))
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ awarded: true }) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Click Share on X and return the decoded tweet text. */
function tweetTextFrom(ui: React.ReactElement): string {
  render(ui)
  fireEvent.click(screen.getByRole("button", { name: /share on x/i }))
  const u = new URL(opened as string)
  return u.searchParams.get("text") ?? ""
}

describe("ShareProfileButtons — tweet copy", () => {
  it("does not claim the collector holds NBA Top Shot", () => {
    const text = tweetTextFrom(<ShareProfileButtons username="trevor" fmv={1500} moments={200} />)
    expect(text).not.toMatch(/NBA Top Shot/i)
    expect(text).toContain("@RipPacksCity")
  })

  it("carries the portfolio figures it was given", () => {
    const text = tweetTextFrom(<ShareProfileButtons username="trevor" fmv={1500} moments={200} />)
    expect(text).toContain("$1.5K")
    expect(text).toContain("200 Moments")
  })

  it("omits the figures rather than tweeting a zero", () => {
    // Same rule as the unfurl description: a total we do not have must fall out
    // of the sentence, not be published as $0.
    const text = tweetTextFrom(<ShareProfileButtons username="trevor" fmv={0} moments={0} />)
    expect(text).not.toMatch(/\$0|\b0 Moments\b/)
  })

  it("names the trophy case when there is one", () => {
    const text = tweetTextFrom(
      <ShareProfileButtons username="trevor" fmv={100} moments={5} trophyCount={3} />,
    )
    expect(text).toMatch(/trophy case/i)
  })

  it("claims a FULL case only when all six slots are filled", () => {
    const partial = tweetTextFrom(
      <ShareProfileButtons username="t" fmv={100} moments={5} trophyCount={3} />,
    )
    expect(partial).not.toMatch(/all 6/i)
    cleanup()
    const full = tweetTextFrom(
      <ShareProfileButtons username="t" fmv={100} moments={5} trophyCount={6} />,
    )
    expect(full).toMatch(/all 6/i)
  })

  it("says nothing about a case that is empty", () => {
    const text = tweetTextFrom(
      <ShareProfileButtons username="trevor" fmv={100} moments={5} trophyCount={0} />,
    )
    expect(text).not.toMatch(/trophy case/i)
  })

  it("attaches the profile URL with attribution params", () => {
    render(<ShareProfileButtons username="trevor" fmv={1} moments={1} referrerId="me" />)
    fireEvent.click(screen.getByRole("button", { name: /share on x/i }))
    const url = new URL(opened as string).searchParams.get("url") ?? ""
    expect(url).toContain("/profile/trevor")
    expect(url).toContain("utm_source=share")
    expect(url).toContain("ref=me")
  })
})
