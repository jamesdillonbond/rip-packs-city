// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import FirstRunTour from "@/components/onboarding/FirstRunTour"

// ─────────────────────────────────────────────────────────────────────────────
// The tour's ANCHORING half, which nothing exercised.
//
// `component-onboarding-first-run-tour.test.tsx` covers the step machine and the
// dismissal contract. Every one of its cases runs with NO `[data-tour-anchor]`
// element in the DOM, so the whole positioning path — spotlight, scroll-into-
// view, and all three vertical placements — was unreached, and it is the half
// that shipped most recently.
//
// ⚠ THIS REPO'S STANDING WARNING APPLIES AND IS WHY THE RECTS ARE STUBBED:
// jsdom does no layout, so `getBoundingClientRect()` returns ZEROES for every
// element. A test that merely renders an anchor is therefore measuring a
// 0×0 box at the origin — it would take the "fits below" branch every time and
// vouch for placement logic it never ran. Each case below installs the rect it
// is actually about. That makes these tests about the ARITHMETIC, not about
// layout; nothing in jsdom can test layout, and this file does not claim to.
//
// ⭐ The case that matters most is the tall anchor. The component's own comment
// records the defect: a section taller than the room left for the popover used
// to fall back to CENTRED, i.e. the tour drew its own popover on top of the
// thing it was pointing at.
// ─────────────────────────────────────────────────────────────────────────────

const VIEWPORT_W = 1024
const VIEWPORT_H = 768

/** Popover height when jsdom reports 0 — the component's own documented default. */
const POPOVER_H = 200
const POPOVER_W = 380

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response)
  vi.stubGlobal("fetch", fetchMock)
  Object.defineProperty(window, "innerWidth", { value: VIEWPORT_W, configurable: true })
  Object.defineProperty(window, "innerHeight", { value: VIEWPORT_H, configurable: true })
  // ⚠ THE POPOVER'S OWN SIZE HAS TO BE STUBBED TOO, and the first draft of this
  // file did not — which made every case measure a ZERO-height popover, so
  // "fits below" was true for an anchor 38px off the bottom of the screen and
  // three of the four placement cases asserted the wrong number.
  //
  // ⚠ And the component's `node?.offsetHeight ?? 200` fallback does NOT rescue
  // it: `??` catches null/undefined, and jsdom returns a real `0`. The default
  // is therefore unreachable in this environment — do not reason from it.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { value: POPOVER_W, configurable: true })
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { value: POPOVER_H, configurable: true })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  clearAnchors()
})

/**
 * ⚠ Anchors are appended to `document.body` and `cleanup()` only unmounts what
 * React rendered — it does not touch them. Left in place they accumulate, and
 * the component's `document.querySelector` then finds a PREVIOUS test's anchor,
 * so a case measures a rect it never installed. That is not hypothetical: the
 * first run of this file reported a spotlight at the far-right clamp case's
 * coordinates inside the anchor-removed case.
 */
function clearAnchors() {
  document.querySelectorAll("[data-tour-anchor]").forEach((n) => n.remove())
}

/**
 * Put an anchor in the document with a stubbed rect, and return the
 * scrollIntoView spy so a case can assert on it.
 */
function mountAnchor(
  name: string,
  rect: { top: number; left: number; width: number; height: number },
) {
  const el = document.createElement("div")
  el.setAttribute("data-tour-anchor", name)
  el.getBoundingClientRect = () =>
    ({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      bottom: rect.top + rect.height,
      right: rect.left + rect.width,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect
  const scrollSpy = vi.fn()
  el.scrollIntoView = scrollSpy
  document.body.appendChild(el)
  return { el, scrollSpy }
}

/** Walk to step 2 — anchored on `portfolio-stats` since 2026-09-03 (the collection switcher is not on the dashboard; the wallets card is step 3’s). */
function renderAtAnchoredStep() {
  const view = render(<FirstRunTour enabled onDismiss={() => {}} />)
  fireEvent.click(view.getByRole("button", { name: /show me/i }))
  return view
}

/** The popover's inline top/left, as numbers. */
function popoverBox(container: HTMLElement) {
  const el = container.querySelector<HTMLElement>('[role="dialog"]')!
  return { el, top: parseFloat(el.style.top), left: parseFloat(el.style.left), transform: el.style.transform }
}

describe("FirstRunTour — it points AT the anchor, never over it", () => {
  it("NO-CHANGE CONTROL: with no anchor in the DOM the popover is centred and no spotlight is cut", () => {
    // Step 1 has no anchor at all. This is the state every existing test runs
    // in, so it must keep behaving exactly as before.
    const { container } = render(<FirstRunTour enabled onDismiss={() => {}} />)
    expect(container.querySelector("[data-tour-spotlight]")).toBeNull()
    const { el, top, left, transform } = popoverBox(container)
    expect(transform).toContain("translate(-50%, -50%)")
    // The centred branch sets PERCENTAGES, not pixels — asserted on the raw
    // strings, because `parseFloat("50%")` is 50 and would read as a placement.
    expect(el.style.top).toBe("50%")
    expect(el.style.left).toBe("50%")
    void top; void left
  })

  it("an anchor with room below places the popover BELOW it and cuts a spotlight around it", () => {
    mountAnchor("portfolio-stats", { top: 100, left: 400, width: 200, height: 40 })
    const { container } = renderAtAnchoredStep()

    const spot = container.querySelector<HTMLElement>("[data-tour-spotlight]")
    expect(spot, "an anchored step must cut a spotlight").not.toBeNull()
    // 6px of padding on every side — asserted as the property (the hole is
    // BIGGER than the anchor), not as four magic numbers.
    expect(parseFloat(spot!.style.top)).toBeLessThan(100)
    expect(parseFloat(spot!.style.left)).toBeLessThan(400)
    expect(parseFloat(spot!.style.width)).toBeGreaterThan(200)
    expect(parseFloat(spot!.style.height)).toBeGreaterThan(40)

    const { top, transform } = popoverBox(container)
    expect(transform).not.toContain("translate(-50%, -50%)")
    // Below the anchor's bottom edge (140), with a gap.
    expect(top).toBeGreaterThan(140)
  })

  it("an anchor near the BOTTOM flips the popover above it rather than off-screen", () => {
    // bottom = 730, so below would need 730 + 12 + 200 = 942 > 768.
    mountAnchor("portfolio-stats", { top: 690, left: 400, width: 200, height: 40 })
    const { container } = renderAtAnchoredStep()
    const { top } = popoverBox(container)
    // 690 - 200 - 12 = 478: fully above the anchor, fully on screen.
    expect(top).toBe(690 - POPOVER_H - 12)
    expect(top).toBeGreaterThanOrEqual(0)
    // It must still be a real placement, not the centred fallback.
    expect(popoverBox(container).transform).not.toContain("translate(-50%, -50%)")
  })

  it("⭐ AN ANCHOR TALLER THAN THE VIEWPORT PINS TO THE BOTTOM — it does not centre ON TOP of it", () => {
    // The recorded defect: a whole dashboard section fits neither above nor
    // below, and the old fallback drew the popover across the middle of the
    // thing the tour was pointing at.
    mountAnchor("portfolio-stats", { top: 0, left: 0, width: VIEWPORT_W, height: 900 })
    const { container } = renderAtAnchoredStep()
    const { top, transform } = popoverBox(container)
    expect(transform).not.toContain("translate(-50%, -50%)")
    // Pinned near the bottom edge, not at the vertical middle.
    expect(top).toBe(Math.max(16, VIEWPORT_H - POPOVER_H - 16))
    expect(top).toBeGreaterThan(VIEWPORT_H / 2)
  })

  it("a far-left and a far-right anchor both clamp inside the viewport", () => {
    mountAnchor("portfolio-stats", { top: 100, left: -50, width: 40, height: 40 })
    const left = popoverBox(renderAtAnchoredStep().container).left
    expect(left).toBeGreaterThanOrEqual(16)
    cleanup()
    clearAnchors()

    mountAnchor("portfolio-stats", { top: 100, left: VIEWPORT_W - 20, width: 40, height: 40 })
    const right = popoverBox(renderAtAnchoredStep().container).left
    expect(right).toBeLessThanOrEqual(VIEWPORT_W - POPOVER_W - 16)
  })

  it("an OFF-SCREEN anchor is scrolled into view before measuring; an on-screen one is not", () => {
    // Without the scroll the anchor's rect is off the bottom of the viewport,
    // nothing fits, and the popover lands on the fallback — "anchored" to
    // something the reader cannot see.
    const offscreen = mountAnchor("portfolio-stats", { top: 2000, left: 400, width: 200, height: 40 })
    renderAtAnchoredStep()
    expect(offscreen.scrollSpy).toHaveBeenCalled()
    cleanup()
    clearAnchors()

    // NO-CHANGE CONTROL, and it is the half that would silently regress: an
    // anchor already in view must NOT be scrolled, or every step yanks the page.
    const onscreen = mountAnchor("portfolio-stats", { top: 100, left: 400, width: 200, height: 40 })
    renderAtAnchoredStep()
    expect(onscreen.scrollSpy).not.toHaveBeenCalled()
  })

  it("a repositioning event does not throw when the anchor has been removed mid-tour", () => {
    // The anchor lives on a page the tour does not own, so it can disappear
    // between steps. The listener must survive that and fall back to centred.
    const { el } = mountAnchor("portfolio-stats", { top: 100, left: 400, width: 200, height: 40 })
    const { container } = renderAtAnchoredStep()
    expect(container.querySelector("[data-tour-spotlight]")).not.toBeNull()
    el.remove()
    fireEvent(window, new Event("resize"))
    expect(container.querySelector("[data-tour-spotlight]")).toBeNull()
    expect(popoverBox(container).transform).toContain("translate(-50%, -50%)")
  })
})
