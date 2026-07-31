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

  it("renders step 1 of 5 with the welcome copy", () => {
    const { getByRole, getByText } = render(<FirstRunTour enabled onDismiss={() => {}} />)
    expect(getByRole("dialog")).toBeTruthy()
    expect(getByText(/Step 1 of 5/i)).toBeTruthy()
    expect(getByText("Welcome to Rip Packs City")).toBeTruthy()
  })

  it("advances forward through steps and can go Back", () => {
    const { getByText, queryByText } = render(<FirstRunTour enabled onDismiss={() => {}} />)
    fireEvent.click(getByText("Show me around"))
    expect(getByText(/Step 2 of 5/i)).toBeTruthy()
    // Back is present from step 2 onward
    fireEvent.click(getByText("← Back"))
    expect(getByText(/Step 1 of 5/i)).toBeTruthy()
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
    // advance to the last step (5)
    fireEvent.click(getByText("Show me around")) // 1->2
    fireEvent.click(getByText("Got it")) // 2->3
    fireEvent.click(getByText("Got it")) // 3->4
    fireEvent.click(getByText("Got it")) // 4->5
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
  it("skips the fetch and renders nothing when localStorage says completed", async () => {
    localStorage.setItem("rpc:first-run-completed", "1")
    const { container } = render(<FirstRunTourMount />)
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull())
    expect(fetchMock).not.toHaveBeenCalled()
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
