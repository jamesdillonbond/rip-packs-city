// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import FirstRunTour from "@/components/onboarding/FirstRunTour"
import FirstRunTourMount from "@/components/onboarding/FirstRunTourMount"

// Covers the onboarding subtree: the first-run product tour's step machine +
// dismissal contract (POST completion stamp + localStorage fallback + Esc +
// backdrop), and the Mount wrapper's fetch-gated / localStorage-fast-path
// render decision.

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response)
  vi.stubGlobal("fetch", fetchMock)
  try { localStorage.clear() } catch { /* ignore */ }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("FirstRunTour", () => {
  it("renders nothing when disabled", () => {
    const { container } = render(<FirstRunTour enabled={false} onDismiss={() => {}} />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it("renders step 1 of 6 with the welcome copy", () => {
    const { getByRole, getByText } = render(<FirstRunTour enabled onDismiss={() => {}} />)
    expect(getByRole("dialog")).toBeTruthy()
    expect(getByText(/Step 1 of 6/i)).toBeTruthy()
    expect(getByText("Welcome to Rip Packs City")).toBeTruthy()
  })

  it("advances forward through steps and can go Back", () => {
    const { getByText, queryByText } = render(<FirstRunTour enabled onDismiss={() => {}} />)
    fireEvent.click(getByText("Show me around"))
    expect(getByText(/Step 2 of 6/i)).toBeTruthy()
    // Back is present from step 2 onward
    fireEvent.click(getByText("← Back"))
    expect(getByText(/Step 1 of 6/i)).toBeTruthy()
    expect(queryByText("← Back")).toBeNull() // step 1 shows Skip, not Back
  })

  it("Skip on step 1 dismisses and POSTs the completion stamp", async () => {
    const onDismiss = vi.fn()
    const { getByText } = render(<FirstRunTour enabled onDismiss={onDismiss} />)
    fireEvent.click(getByText("Skip"))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/profile/first-run-tour",
        expect.objectContaining({ method: "POST" }),
      ),
    )
    expect(localStorage.getItem("rpc:first-run-completed")).toBe("1")
  })

  it("the final step's CTA dismisses the tour", async () => {
    const onDismiss = vi.fn()
    const { getByText } = render(<FirstRunTour enabled onDismiss={onDismiss} />)
    // advance to the last step (6 — the trophy-case step was added 2026-09-02)
    fireEvent.click(getByText("Show me around")) // 1->2
    fireEvent.click(getByText("Got it")) // 2->3
    fireEvent.click(getByText("Got it")) // 3->4
    fireEvent.click(getByText("Got it")) // 4->5
    fireEvent.click(getByText("Got it")) // 5->6
    fireEvent.click(getByText("Got it, let me explore")) // dismiss
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("Escape dismisses the tour", async () => {
    const onDismiss = vi.fn()
    render(<FirstRunTour enabled onDismiss={onDismiss} />)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("still stamps completion locally when the POST rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"))
    const onDismiss = vi.fn()
    const { getByText } = render(<FirstRunTour enabled onDismiss={onDismiss} />)
    fireEvent.click(getByText("Skip"))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(localStorage.getItem("rpc:first-run-completed")).toBe("1"))
  })
})

describe("FirstRunTourMount", () => {
  // 2026-09-02 (onboarding QA #9): localStorage is per-origin, not per-user. A
  // second account on the same browser inherited the first account's "done"
  // and never saw the tour. The server answer wins over the device flag.
  it("asks the API even when the device flag says completed, and shows the tour if the API says not", async () => {
    localStorage.setItem("rpc:first-run-completed", "1")
    fetchMock.mockResolvedValueOnce(await okJson({ completed: false }))
    const { findByRole } = render(<FirstRunTourMount />)
    expect(await findByRole("dialog")).toBeTruthy()
    expect(fetchMock).toHaveBeenCalled()
    // and the stale device flag is cleared so it cannot mislead the next mount
    expect(localStorage.getItem("rpc:first-run-completed")).toBeNull()
  })

  it("shows nothing when the API cannot answer (a failed read is not a first run)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as any)
    const { container } = render(<FirstRunTourMount />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 20))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it("renders nothing when the API says the tour is completed", async () => {
    fetchMock.mockResolvedValueOnce(await okJson({ completed: true }))
    const { container } = render(<FirstRunTourMount />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(localStorage.getItem("rpc:first-run-completed")).toBe("1")
  })

  it("renders the tour when the API says it is not completed", async () => {
    fetchMock.mockResolvedValueOnce(await okJson({ completed: false }))
    const { findByRole } = render(<FirstRunTourMount />)
    expect(await findByRole("dialog")).toBeTruthy()
  })
})

// 2026-09-02 (onboarding QA #9): anchored steps spotlight the element instead
// of blurring the whole page; the anchor is scrolled into view first, and a
// section taller than the room left pins the popover to the viewport edge.
describe("FirstRunTour — spotlight", () => {
  it("renders no spotlight on the centred welcome step, and one over the anchor once a step has one", () => {
    const anchor = document.createElement("div")
    anchor.setAttribute("data-tour-anchor", "portfolio-stats")
    anchor.getBoundingClientRect = () => ({ top: 40, left: 20, width: 200, height: 30, bottom: 70, right: 220, x: 20, y: 40, toJSON() {} }) as DOMRect
    document.body.appendChild(anchor)
    try {
      const { container, getByText } = render(<FirstRunTour enabled onDismiss={() => {}} />)
      expect(container.querySelector("[data-tour-spotlight]")).toBeNull()
      fireEvent.click(getByText("Show me around"))
      const spot = container.querySelector("[data-tour-spotlight]") as HTMLElement
      expect(spot).toBeTruthy()
      // 6px of padding around the anchor rect
      expect(spot.style.top).toBe("34px")
      expect(spot.style.left).toBe("14px")
      expect(spot.style.width).toBe("212px")
    } finally {
      anchor.remove()
    }
  })

  it("scrolls an off-screen anchor into view and pins the popover to the bottom edge when the anchor is taller than the room", () => {
    const anchor = document.createElement("div")
    anchor.setAttribute("data-tour-anchor", "portfolio-stats")
    const scrollIntoView = vi.fn()
    anchor.scrollIntoView = scrollIntoView
    // Taller than the viewport: neither above nor below fits.
    anchor.getBoundingClientRect = () => ({ top: 900, left: 0, width: 800, height: 2000, bottom: 2900, right: 800, x: 0, y: 900, toJSON() {} }) as DOMRect
    document.body.appendChild(anchor)
    try {
      const { container, getByText } = render(<FirstRunTour enabled onDismiss={() => {}} />)
      fireEvent.click(getByText("Show me around"))
      expect(scrollIntoView).toHaveBeenCalled()
      const dialog = container.querySelector('[role="dialog"]') as HTMLElement
      // pinned (a concrete top), not centred (translate(-50%,-50%))
      expect(dialog.style.transform).toBe("")
      expect(container.querySelector("[data-tour-spotlight]")).toBeTruthy()
    } finally {
      anchor.remove()
    }
  })
})
