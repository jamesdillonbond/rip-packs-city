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

  it("renders the progressHint string for every earned achievement key (incl. non-numeric → 0)", async () => {
    fetchMock.mockReturnValue(
      okJson({
        achievements: [
          { achievement_key: "big_spender", tier: "gold", progress: { amount: 12345 }, unlocked_at: "x" },
          { achievement_key: "serial_sniper", tier: "silver", progress: { serial10: 4 }, unlocked_at: "x" },
          { achievement_key: "series_collector", tier: "bronze", progress: { count: 6 }, unlocked_at: "x" },
          { achievement_key: "trophy_curator", tier: "gold", progress: { count: 5 }, unlocked_at: "x" },
          { achievement_key: "challenge_accepted", tier: "gold", progress: { count: 3 }, unlocked_at: "x" },
          { achievement_key: "diamond_hands", tier: "gold", progress: { count: "nope" }, unlocked_at: "x" }, // non-finite -> 0
        ],
      }),
    )
    const { getByText } = render(<AchievementsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText("$12,345 spent")).toBeTruthy()) // big_spender
    expect(getByText("4 × #≤10")).toBeTruthy()      // serial_sniper
    expect(getByText("6 series")).toBeTruthy()       // series_collector
    expect(getByText("5 / 6")).toBeTruthy()          // trophy_curator
    expect(getByText("3 challenges")).toBeTruthy()   // challenge_accepted
    expect(getByText("0 Legendaries")).toBeTruthy()  // diamond_hands, num("nope") -> 0
  })

  it("does not fetch when ownerKey is empty (guard) and clears the loading skeleton", async () => {
    render(<AchievementsCard ownerKey="" />)
    // load() returns before fetching; the skeleton clears once loading settles.
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled())
  })

  // ⚠⚠ THESE TWO TESTS WERE INVERTED ON 2026-08-26. They did not merely miss the
  // defect — they PINNED it. Both asserted that a failed read renders the count
  // badge "0 / 7", which is a MEASURED claim about the reader's own account
  // produced by a read that never landed, while every badge rendered locked.
  //
  // The repo's rule is that a test pinning the defect it was named to prevent
  // gets INVERTED, never deleted: the assertion is what holds the behaviour in
  // place, so it has to keep existing and say the opposite. The names are kept
  // close to the originals so the history stays greppable.

  it("does NOT publish a measured 0 / 7 when the read returned a non-ok status", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, json: () => Promise.resolve(null) } as Response),
    )
    const { queryByText, getByText } = render(<AchievementsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText("UNAVAILABLE")).toBeTruthy())
    // The fabricated number must be ABSENT — asserting the error copy is present
    // is the weaker claim, and the weaker claim is what let this ship.
    expect(queryByText("0 / 7")).toBeNull()
  })

  it("treats a 200 with no achievements array as a failed read, not an empty one", async () => {
    // read ok + unrenderable is the third state, and it is not zero.
    fetchMock.mockReturnValueOnce(okJson({ ok: true })) // no `achievements` key
    const { queryByText, getByText } = render(<AchievementsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText("UNAVAILABLE")).toBeTruthy())
    expect(queryByText("0 / 7")).toBeNull()
  })

  it("NO-CHANGE CONTROL — a genuinely empty achievements array still reads 0 / 7", async () => {
    // Without this, suppressing the badge unconditionally would satisfy both
    // tests above and destroy the real empty state: a collector who has
    // genuinely unlocked nothing must still see their count.
    fetchMock.mockReturnValueOnce(okJson({ achievements: [] }))
    const { queryByText, getByText } = render(<AchievementsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText("0 / 7")).toBeTruthy())
    expect(queryByText("UNAVAILABLE")).toBeNull()
  })

  // ⚠ POSITIVE CONTROL FIRST. The pair below is deliberate: the first test
  // proves this harness can actually reach the "✓ Updated" label, so the
  // second one's `toBeNull()` means something. A first attempt at the second
  // test alone PASSED against the un-fixed component — the promise chain never
  // reached setUpdated under the harness, so the absence assertion was
  // vacuous and the mutation run caught it.
  it("POSITIVE CONTROL — a successful recompute DOES claim Updated", async () => {
    fetchMock.mockReturnValue(okJson({ achievements: [] }))
    const { getByText } = render(<AchievementsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText("0 / 7")).toBeTruthy())
    fireEvent.click(getByText(/Refresh/))
    await waitFor(() => expect(getByText(/Updated/)).toBeTruthy(), { timeout: 4000 })
  })

  it("does NOT claim Updated when the recompute POST failed", async () => {
    // The confirmation must report the RECOMPUTE, not the passage of time: the
    // re-read that follows succeeds either way and simply returns the OLD data.
    fetchMock
      .mockReturnValueOnce(okJson({ achievements: [] }))                                                    // initial load
      .mockReturnValueOnce(Promise.resolve({ ok: false, json: () => Promise.resolve(null) } as Response))    // POST fails
      .mockReturnValue(okJson({ achievements: [] }))                                                        // re-load
    const { getByText, queryByText } = render(<AchievementsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText("0 / 7")).toBeTruthy())
    fireEvent.click(getByText(/Refresh/))
    // Wait for the chain to settle (the re-load lands ~2s later), then assert.
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 4000 })
    expect(queryByText(/Updated/)).toBeNull()
  })

  it("runs the full Refresh callback chain (POST → re-load → clear updated)", async () => {
    // Drive the two nested setTimeouts synchronously so the callback bodies
    // (setRefreshing/setUpdated + the re-load GET) actually execute — without a
    // faked-timer clock that would hang testing-library's waitFor polling.
    fetchMock.mockReturnValue(okJson({ achievements: [] }))
    const { getByText } = render(<AchievementsCard ownerKey="0xowner" />)
    // settle the initial (timer-free) load before touching setTimeout, so the
    // waitFor-free flush below doesn't fight the spy.
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(getByText("↻ Refresh")).toBeTruthy()
    // Now drive the two nested setTimeouts synchronously so the callback bodies
    // (setRefreshing/setUpdated + the re-load GET) actually execute.
    vi.spyOn(window, "setTimeout").mockImplementation((cb: TimerHandler) => {
      if (typeof cb === "function") (cb as () => void)()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    const before = fetchMock.mock.calls.length
    fireEvent.click(getByText("↻ Refresh"))
    // let the POST + nested re-load promise chains settle (each .finally is a microtask)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    const calls = fetchMock.mock.calls
    // a POST recompute was issued...
    expect(calls.some((c) => c[0] === "/api/profile/achievements" && c[1]?.method === "POST")).toBe(true)
    // ...and the timer callback re-loaded via the GET endpoint (proves 85-93 ran).
    expect(
      calls.slice(before).some((c) => String(c[0]).startsWith("/api/profile/achievements?ownerKey=")),
    ).toBe(true)
  })
})
