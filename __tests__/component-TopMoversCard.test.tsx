// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import TopMoversCard from "@/components/profile/TopMoversCard"

// TopMoversCard fetches 7d FMV deltas and splits them into gainers (green,
// "+") and losers (red, "−"). Each row shows current FMV plus the signed
// delta and optional signed percent. Empty gainers/losers arrays each get
// their own inline "No gainers/losers in window." note; a fully empty
// response shows the top-level "FMV history building" empty state.

let fetchMock: ReturnType<typeof vi.fn>
function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("TopMoversCard", () => {
  it("shows the building-history empty state when both sides are empty", async () => {
    fetchMock.mockReturnValue(okJson({ gainers: [], losers: [] }))
    const { container } = render(<TopMoversCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("FMV history building"))
  })

  it("formats a gainer with a + sign and a loser with a − sign", async () => {
    fetchMock.mockReturnValue(
      okJson({
        gainers: [
          { edition_id: "g1", player_name: "Damian Lillard", set_name: "Cosmic", current_fmv: 1200, delta: 200, pct_change: 20 },
        ],
        losers: [
          { edition_id: "l1", player_name: "Anfernee Simons", set_name: "Base", current_fmv: 80, delta: -30, pct_change: -27.3 },
        ],
      })
    )
    const { container } = render(<TopMoversCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("Damian Lillard"))
    const txt = container.textContent!
    // Gainer: current fmv $1.2K, +delta $200.00 · +20.0%
    expect(txt).toContain("$1.2K")
    expect(txt).toContain("+$200.00 · +20.0%")
    // Loser: absolute delta with the − sign and abs percent.
    expect(txt).toContain("−$30.00 · −27.3%")
    expect(txt).toContain("Anfernee Simons")
  })

  it("shows the per-column note when one side is empty and the other is not", async () => {
    fetchMock.mockReturnValue(
      okJson({
        gainers: [{ edition_id: "g1", player_name: "X", set_name: "S", current_fmv: 100, delta: 10, pct_change: null }],
        losers: [],
      })
    )
    const { container } = render(<TopMoversCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("No losers in window."))
    // pct_change null => no percent suffix on the gainer delta.
    expect(container.textContent).toContain("+$10.00")
    expect(container.textContent).not.toContain("+$10.00 ·")
  })
})

// A read that has not happened yet is not an empty read. The server render
// (and the beat before the effect fires, and an empty ownerKey) must show the
// skeleton, never the "history building — check back in a few days"
// conclusion — that copy explains a blank as pipeline progress and sends the
// reader away. Asserted by SSR because a mount effect corrects client state
// before jsdom looks. Seen live 2026-09-03 in the SSR HTML of /profile/qa0903.
describe("TopMoversCard — not-yet-read is not empty", () => {
  it("does not conclude on the server render", async () => {
    const { renderToString } = await import("react-dom/server")
    const html = renderToString(<TopMoversCard ownerKey="0xabc" />)
    expect(html).not.toMatch(/FMV history building/)
    expect(html).not.toMatch(/No gainers in window/)
  })

  it("does not conclude when no fetch can run (empty ownerKey)", () => {
    const { container } = render(<TopMoversCard ownerKey="" />)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(container.textContent).not.toMatch(/FMV history building/)
  })
})
