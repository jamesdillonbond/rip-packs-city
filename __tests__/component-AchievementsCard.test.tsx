// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import AchievementsCard from "@/components/profile/AchievementsCard"

// Drives the profile Achievements card: the loading skeleton, the fetch →
// unlocked-count badge + an earned achievement's progress hint (progressHint), and
// the Refresh button POSTing a recompute. The ACHIEVEMENT_DEFS / tier helpers are
// tested separately (lib/achievements).

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

describe("AchievementsCard", () => {
  it("shows the skeleton while loading", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {})) // never resolves
    const { container } = render(<AchievementsCard ownerKey="0xowner" />)
    expect(container.querySelector(".rpc-skeleton")).toBeTruthy()
  })

  it("renders the unlocked count badge and an earned achievement's progress hint", async () => {
    fetchMock.mockReturnValueOnce(
      okJson({
        achievements: [
          { achievement_key: "pack_hunter", tier: "gold", progress: { count: 42 }, unlocked_at: "2026-04-01" },
        ],
      }),
    )
    const { getByText } = render(<AchievementsCard ownerKey="0xowner" />)
    // 1 unlocked of 7 defined
    await waitFor(() => expect(getByText("1 / 7")).toBeTruthy())
    // progressHint("pack_hunter", {count:42}) → "42 packs"
    expect(getByText("42 packs")).toBeTruthy()
  })

  it("Refresh POSTs a recompute", async () => {
    fetchMock.mockReturnValue(okJson({ achievements: [] }))
    const { getByText } = render(<AchievementsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText("↻ Refresh")).toBeTruthy())
    // handleRefresh schedules a real 2000ms setTimeout that later re-fetches; if it
    // leaked it would fire a relative-URL fetch mid-run and flake a later file.
    // No-op setTimeout while the refresh chain settles so nothing real is scheduled.
    vi.spyOn(window, "setTimeout").mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>)
    fireEvent.click(getByText("↻ Refresh"))
    // the POST is issued synchronously inside handleRefresh
    expect(
      fetchMock.mock.calls.some((c) => c[0] === "/api/profile/achievements" && c[1]?.method === "POST"),
    ).toBe(true)
    // let the .finally microtask run (it calls the no-op setTimeout) before teardown
    await Promise.resolve()
    await Promise.resolve()
    // spy restored by afterEach's vi.restoreAllMocks()
  })
})
