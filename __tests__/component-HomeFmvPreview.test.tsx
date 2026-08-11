// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import HomeFmvPreview from "@/components/HomeFmvPreview"

// components/HomeFmvPreview (0% before this). Fetches the public /api/fmv/demo,
// renders a LIVE card from the first real sample (edition, FMV, serial-adjusted
// examples) and falls back to a clearly-labelled SAMPLE card on any failure —
// never blocking render. Drives the loading / live / sample states and the
// exampleAdjustments-present vs -absent multiplier fallbacks.

let fetchMock: ReturnType<typeof vi.fn>
function demoResp(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("HomeFmvPreview", () => {
  it("shows the LOADING label before the demo fetch resolves", () => {
    fetchMock.mockReturnValue(new Promise(() => {})) // never resolves
    const { container } = render(<HomeFmvPreview />)
    expect(container.textContent).toContain("LOADING FMV")
  })

  it("renders the LIVE card from a real sample with serial-adjusted examples", async () => {
    fetchMock.mockReturnValue(
      demoResp({
        samples: [
          {
            edition: "99:1234",
            fmv: 200,
            confidence: "HIGH",
            exampleAdjustments: {
              serial1: { adjustedFmv: 2400 },
              serial23: { adjustedFmv: 560 },
            },
          },
        ],
      }),
    )
    const { container } = render(<HomeFmvPreview />)
    await waitFor(() => expect(container.textContent).toContain("LIVE FMV PREVIEW"))
    const txt = container.textContent!
    expect(txt).toContain("EDITION 99:1234")
    expect(txt).toContain("$200.00")
    expect(txt).toContain("$2,400.00") // serial #1 adjusted
    expect(txt).toContain("$560.00") // serial #23 adjusted
  })

  it("falls back to computed multipliers when exampleAdjustments are absent", async () => {
    fetchMock.mockReturnValue(
      demoResp({ samples: [{ edition: "1:1", fmv: 100, confidence: "MEDIUM" }] }),
    )
    const { container } = render(<HomeFmvPreview />)
    await waitFor(() => expect(container.textContent).toContain("LIVE FMV PREVIEW"))
    const txt = container.textContent!
    expect(txt).toContain("$100.00")
    expect(txt).toContain("$1,200.00") // fmv * 12
    expect(txt).toContain("$280.00") // fmv * 2.8
  })

  it("falls back to the SAMPLE card when the fetch is not ok", async () => {
    fetchMock.mockReturnValue(demoResp(null, false))
    const { container } = render(<HomeFmvPreview />)
    await waitFor(() => expect(container.textContent).toContain("SAMPLE FMV CARD"))
    // Hardcoded fallback edition/fmv.
    expect(container.textContent).toContain("EDITION 84:2892")
    expect(container.textContent).toContain("$148.00")
  })

  it("falls back to the SAMPLE card when samples is empty / missing", async () => {
    fetchMock.mockReturnValue(demoResp({ samples: [] }))
    const { container } = render(<HomeFmvPreview />)
    await waitFor(() => expect(container.textContent).toContain("SAMPLE FMV CARD"))
  })

  it("falls back to the SAMPLE card when the first sample has a non-numeric fmv", async () => {
    fetchMock.mockReturnValue(demoResp({ samples: [{ edition: "1:1", fmv: "oops" }] }))
    const { container } = render(<HomeFmvPreview />)
    await waitFor(() => expect(container.textContent).toContain("SAMPLE FMV CARD"))
  })

  it("falls back to the SAMPLE card when the fetch rejects", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("network")))
    const { container } = render(<HomeFmvPreview />)
    await waitFor(() => expect(container.textContent).toContain("SAMPLE FMV CARD"))
  })
})
