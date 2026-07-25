// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react"
import PackContentsFallback from "@/components/packs/PackContentsFallback"

// DEFECT REGRESSION (2026-07-25): pack "What's Inside" spun on
// "Loading pack contents…" forever.
//
// The section is an async server component behind <Suspense>, so its content
// arrives in the tail of the initial response — there is no client request, which
// is why the symptom looked like "zero API calls fired". Verified live: the DB is
// healthy (get_pack_contents = 24 rows / 67 ms on dist 1599) and a full curl of
// the production page returns the completely rendered section plus its trailing
// $RC completion script in ~1.1s — yet a real browser still sat on the fallback
// with readyState "complete", the hidden segment unconsumed, and no console error.
//
// Since the trigger is on the client stream-completion path, the durable fix is
// that the FALLBACK must bound itself. This component is mounted only while the
// boundary is unresolved, so a fired timer proves the swap never happened. These
// tests pin the three outcomes: recover, honest failure, and honest empty — and
// above all that it never stays on the spinner indefinitely.
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })

const ROW = {
  route_slug: "45663101",
  player_name: "LaMelo Ball",
  name: "LaMelo Ball — Crunch Time",
  tier: "COMMON",
  series_label: "Series 4",
  circulation_count: 1000,
  thumbnail_url: null,
  fmv_usd: 4.2,
}

function mount() {
  return render(<PackContentsFallback collection="nba-top-shot" distId="1599" pageSize={24} />)
}

describe("PackContentsFallback", () => {
  it("shows the skeleton first and fires no request before the stall window", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    mount()
    expect(screen.getByText("Loading pack contents…")).toBeTruthy()
    vi.advanceTimersByTime(8_000)
    // A merely-slow stream must not trigger a duplicate read.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("recovers the contents over /api/entity/pack once the boundary has stalled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [ROW] })
    vi.stubGlobal("fetch", fetchMock)
    mount()
    vi.advanceTimersByTime(9_000)
    await waitFor(() => expect(screen.getByText("What's Inside")).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/entity/pack?collection=nba-top-shot&dist_id=1599&offset=0&limit=24",
    )
    expect(screen.queryByText("Loading pack contents…")).toBeNull()
  })

  it("states the failure plainly instead of spinning when recovery errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    mount()
    vi.advanceTimersByTime(9_000)
    await waitFor(() => expect(screen.getByText(/Couldn't load this pack's contents/)).toBeTruthy())
    expect(screen.queryByText("Loading pack contents…")).toBeNull()
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy()
  })

  it("states the failure plainly when the fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))
    mount()
    vi.advanceTimersByTime(9_000)
    await waitFor(() => expect(screen.getByText(/Couldn't load this pack's contents/)).toBeTruthy())
  })

  it("Retry re-attempts and can succeed after a transient failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [ROW] })
    vi.stubGlobal("fetch", fetchMock)
    mount()
    vi.advanceTimersByTime(9_000)
    await waitFor(() => expect(screen.getByText(/Couldn't load this pack's contents/)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    await waitFor(() => expect(screen.getByText("What's Inside")).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("distinguishes a genuinely empty pool from a load failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }))
    mount()
    vi.advanceTimersByTime(9_000)
    await waitFor(() => expect(screen.getByText(/aren't indexed for this distribution yet/)).toBeTruthy())
    // An empty pool is an answer, not an error — no scary copy, no retry button.
    expect(screen.queryByText(/Couldn't load/)).toBeNull()
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull()
  })

  it("never remains on the spinner after the stall window in any outcome", async () => {
    for (const impl of [
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [ROW] }),
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }),
      vi.fn().mockRejectedValue(new Error("x")),
    ]) {
      vi.stubGlobal("fetch", impl)
      mount()
      vi.advanceTimersByTime(9_000)
      await waitFor(() => expect(screen.queryByText("Loading pack contents…")).toBeNull())
      cleanup()
    }
  })

  it("cancels the stall timer when the boundary resolves and unmounts it", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { unmount } = mount()
    unmount() // React swapped in the real streamed section
    vi.advanceTimersByTime(30_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
