// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"
import ShareProfileButtons from "@/components/profile/ShareProfileButtons"

// Pins the "share your collection" affordance: the UTM-tagged profile URL each
// action builds (attribution + the &ref= referral loop), the X-intent open, the
// clipboard copy + "Copied!" state, and the fire-and-forget rewards track whose
// {awarded} result drives the +50 / already-earned note. These are the pieces
// that make the referral/rewards loop actually fire — silent breakage here loses
// attribution and reward credit.

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

  it("shows the +50 earned note when the reward track returns awarded:true", async () => {
    render(<ShareProfileButtons username="trevor" />)
    fireEvent.click(screen.getByRole("button", { name: "Share on X" }))
    await waitFor(() => expect(screen.getByText(/\+50 Status earned/i)).toBeTruthy())
  })

  it("shows the already-earned note when awarded:false", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ awarded: false }) } as any)
    render(<ShareProfileButtons username="trevor" />)
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
    await waitFor(() => expect(screen.getByText(/Already earned your share bonus today/i)).toBeTruthy())
  })
})
