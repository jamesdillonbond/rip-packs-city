// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"
import ShareProfileButtons from "@/components/profile/ShareProfileButtons"

// Pins the "share your collection" affordance: the UTM-tagged profile URL each
// action builds (attribution + the &ref= referral loop), the X-intent open, the
// clipboard copy + "Copied!" state, and the fire-and-forget rewards track.
//
// ⚠ TWO CASES HERE WERE INVERTED ON 2026-08-16, AND THAT IS THE POINT. They
// asserted the "+50 Status earned for sharing" / "Already earned your share
// bonus today" notes, and they were CORRECT tests for the behaviour that
// existed. Once the rewards program was pulled from every user-facing surface
// (it is not built out, so the promise could not be honoured), a passing test
// asserting the promise is the thing HOLDING IT IN PLACE — it would red the
// removal and read as a regression. They now assert the notes are ABSENT while
// the silent accrual still fires, so a revert reds instead.

let openMock: ReturnType<typeof vi.fn>
let writeTextMock: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  openMock = vi.fn()
  vi.stubGlobal("open", openMock)
  writeTextMock = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { value: { writeText: writeTextMock }, configurable: true })
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ awarded: true }) }) as any)
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("ShareProfileButtons", () => {
  it("renders both actions", () => {
    render(<ShareProfileButtons username="trevor" />)
    expect(screen.getByRole("button", { name: "Share on X" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy()
  })

  it("Share on X opens a twitter intent carrying the utm=x profile URL + tweet text, and tracks the reward", async () => {
    render(<ShareProfileButtons username="trevor" fmv={2500} moments={120} />)
    fireEvent.click(screen.getByRole("button", { name: "Share on X" }))
    expect(openMock).toHaveBeenCalledTimes(1)
    const intent = decodeURIComponent(String(openMock.mock.calls[0][0]))
    expect(intent).toContain("twitter.com/intent/tweet")
    expect(intent).toContain("/profile/trevor?utm_source=share&utm_medium=x")
    expect(intent).toContain("RipPacksCity") // tweet text
    expect(intent).toContain("$2.5K") // fmv stat formatted
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/rewards/track", expect.anything()))
  })

  it("Copy link writes the utm=copy URL to the clipboard and flips to 'Copied!'", async () => {
    render(<ShareProfileButtons username="trevor" />)
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(1))
    expect(String(writeTextMock.mock.calls[0][0])).toContain("utm_medium=copy")
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied!" })).toBeTruthy())
  })

  it("carries the &ref= referral param when referrerId is supplied", () => {
    render(<ShareProfileButtons username="trevor" referrerId="user-99" />)
    fireEvent.click(screen.getByRole("button", { name: "Share on X" }))
    const intent = decodeURIComponent(String(openMock.mock.calls[0][0]))
    expect(intent).toContain("ref=user-99")
  })

  it("never promises points, whatever the reward track answers", async () => {
    // The rewards program is not built out, so no surface may confirm an earn.
    // Driven through BOTH answers the endpoint can give, because the component
    // used to render a different note for each.
    for (const awarded of [true, false]) {
      cleanup()
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ awarded }) } as any)
      render(<ShareProfileButtons username="trevor" />)
      fireEvent.click(screen.getByRole("button", { name: "Share on X" }))
      // Await the tracking call so the assertion lands AFTER the point where
      // the note used to appear — asserting an absence before the fetch settles
      // would pass against the old code too, and prove nothing.
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      const text = document.body.textContent ?? ""
      expect(text).not.toMatch(/\+50/)
      expect(text).not.toMatch(/Status/i)
      expect(text).not.toMatch(/earned/i)
      expect(text).not.toMatch(/bonus/i)
    }
  })

  // 2026-09-02 onboarding QA finding #3: the trophy-case share page shared the
  // PROFILE url, so X unfurled the profile card rather than the trophy case the
  // sharer was looking at, and the link carried no &ref=. Pin the surface.
  it("surface=trophy-case shares the trophy-case URL, leads the tweet with the case, and warms its card", async () => {
    render(<ShareProfileButtons username="trevor" surface="trophy-case" trophyCount={3} referrerId="user-7" />)
    fireEvent.click(screen.getByRole("button", { name: "Share on X" }))
    const intent = decodeURIComponent(String(openMock.mock.calls[0][0]))
    expect(intent).toContain("/profile/trevor/trophy-case?utm_source=share&utm_medium=x")
    expect(intent).toContain("ref=user-7")
    expect(intent).toMatch(/trophy case/i)
    expect(intent).toContain("3 Moments")
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/og/trophy-case/trevor", expect.anything()),
    )
  })

  it("surface=trophy-case copies the trophy-case URL", async () => {
    render(<ShareProfileButtons username="trevor" surface="trophy-case" />)
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(1))
    expect(String(writeTextMock.mock.calls[0][0])).toContain("/profile/trevor/trophy-case?utm_source=share&utm_medium=copy")
  })

  it("the default surface is still the profile (a revert of the trophy page stays visible)", () => {
    render(<ShareProfileButtons username="trevor" />)
    fireEvent.click(screen.getByRole("button", { name: "Share on X" }))
    const intent = decodeURIComponent(String(openMock.mock.calls[0][0]))
    expect(intent).toContain("/profile/trevor?utm_source=share")
    expect(intent).not.toContain("/trophy-case")
  })

  it("still fires the silent accrual, so the data is there when rewards ship", async () => {
    // Removing the CLAIM must not remove the tracking — that distinction is the
    // whole design, and deleting the fetch would be an easy "cleanup" later.
    render(<ShareProfileButtons username="trevor" />)
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/rewards/track", expect.anything()),
    )
  })
})
