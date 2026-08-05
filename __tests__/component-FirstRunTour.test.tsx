// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import FirstRunTour from "@/components/onboarding/FirstRunTour"

// FirstRunTour is a modal-style onboarding popover. It adopts the shared
// useModalA11y hook, so it now has real dialog semantics: role=dialog, focus
// moved INTO the dialog on open, Tab trapped, Escape to dismiss, focus restored
// on close. These pin that contract (the focus-in test bites against the old
// version, which had no focus management).

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("FirstRunTour", () => {
  it("renders a labelled dialog when enabled", () => {
    const { container } = render(<FirstRunTour enabled onDismiss={vi.fn()} />)
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.getAttribute("aria-modal")).toBe("true")
  })

  it("renders nothing when disabled", () => {
    const { container } = render(<FirstRunTour enabled={false} onDismiss={vi.fn()} />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it("moves focus into the dialog on open (was unmanaged before the hook)", async () => {
    const { container } = render(<FirstRunTour enabled onDismiss={vi.fn()} />)
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true)
    })
  })

  it("dismisses on Escape (via the shared modal-a11y hook)", () => {
    const onDismiss = vi.fn()
    render(<FirstRunTour enabled onDismiss={onDismiss} />)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
