// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { coveringSentence } from "@/components/HomePageMarketing"
import InsightsEmailCapture from "@/components/insights/InsightsEmailCapture"
import WatchEditionButton from "@/components/alerts/WatchEditionButton"

// Two small edges nothing pinned (2026-10-11):
//  - the homepage's "Covering …" sentence is built from the registry, so it must read
//    correctly at ONE collection and say nothing at ZERO (never "Covering , and .");
//  - the insights email capture must not claim "Check your inbox" when /api/subscribe
//    answers with a non-JSON error page (a gateway 502 / HTML), the false-success shape.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("coveringSentence", () => {
  it("says nothing for zero collections", () => {
    expect(coveringSentence([])).toBe("")
  })
  it("reads naturally for one collection", () => {
    expect(coveringSentence(["NBA Top Shot"])).toBe("Covering NBA Top Shot.")
  })
  it("CONTROL: the multi-collection form is unchanged", () => {
    expect(coveringSentence(["A", "B", "C"])).toBe("Covering A, B, and C.")
  })
})

describe("InsightsEmailCapture — a non-JSON error response", () => {
  it("🚨 a 502 with an HTML body shows an error, never 'Check your inbox'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.reject(new SyntaxError("Unexpected token <")),
        } as unknown as Response),
      ),
    )
    const { getByPlaceholderText, container, findByText, queryByText } = render(<InsightsEmailCapture />)
    fireEvent.change(getByPlaceholderText("you@example.com"), { target: { value: "a@b.co" } })
    fireEvent.submit(container.querySelector("form")!)
    expect(await findByText("Something went wrong — try again.")).toBeTruthy()
    await waitFor(() => expect(queryByText(/Check your inbox/)).toBeNull())
  })
})


describe("WatchEditionButton — a non-JSON error response", () => {
  it("🚨 a 500 with an HTML body says the alert was NOT saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          redirected: false,
          json: () => Promise.reject(new SyntaxError("Unexpected token <")),
        } as unknown as Response),
      ),
    )
    const { container, getByText, findByText, queryByText } = render(
      <WatchEditionButton editionKey="26:1234" collectionId="95f28a17-224a-4025-96ad-adf8a4c63bfd" />,
    )
    fireEvent.click(container.querySelector("button")!)
    fireEvent.change(container.querySelector('input[type="number"]')!, { target: { value: "50" } })
    fireEvent.click(getByText("Set alert"))
    expect(await findByText("Could not save the alert.")).toBeTruthy()
    expect(queryByText(/Alert set/)).toBeNull()
  })
})
