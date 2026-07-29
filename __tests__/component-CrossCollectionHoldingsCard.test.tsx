// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import CrossCollectionHoldingsCard from "@/components/analytics/CrossCollectionHoldingsCard"

// Drives the cross-collection holdings chips: the 0x-input short-circuit (renders
// nothing — this is a username card), the /api/public/profile fetch → bucketing
// wallet moment counts by collection_id → UUID→Collection label/accent resolution
// → chips sorted by count desc, and the null-render on a missing profile.

vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

// Real collection UUIDs (from CLAUDE.md / lib/collections).
const TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("CrossCollectionHoldingsCard", () => {
  it("renders nothing for a 0x address input (it is a username card)", () => {
    const { container } = render(<CrossCollectionHoldingsCard usernameInput="0xabc" />)
    expect(container.firstChild).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("buckets wallet moment counts by collection and renders labelled chips desc", async () => {
    fetchMock.mockReturnValueOnce(
      okJson({
        wallets: [
          { collection_id: ALLDAY, cached_moment_count: 30 },
          { collection_id: TOPSHOT, cached_moment_count: 50 },
          { collection_id: TOPSHOT, cached_moment_count: 20 }, // sums to 70 for Top Shot
        ],
      }),
    )
    const { getByText, container } = render(<CrossCollectionHoldingsCard usernameInput="@whale" />)
    await waitFor(() => expect(getByText("Cross-Collection Holdings")).toBeTruthy())
    expect(getByText("NBA Top Shot")).toBeTruthy()
    expect(getByText("70 moments")).toBeTruthy() // 50 + 20 summed
    expect(getByText("NFL All Day")).toBeTruthy()
    expect(getByText("30 moments")).toBeTruthy()
    // Top Shot (70) sorts before All Day (30)
    const text = container.textContent ?? ""
    expect(text.indexOf("NBA Top Shot")).toBeLessThan(text.indexOf("NFL All Day"))
    // fetch stripped the leading @
    expect(fetchMock.mock.calls[0][0]).toContain("/api/public/profile/whale")
  })

  it("renders nothing when the profile is missing (non-ok)", async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 404 } as Response))
    const { container } = render(<CrossCollectionHoldingsCard usernameInput="ghost" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })
})
