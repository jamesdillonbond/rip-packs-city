// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, act } from "@testing-library/react"
import DeadImageGuard, { DEAD_ART_PIXEL, neutraliseDeadImage, sweepDeadImages } from "@/components/media/DeadImageGuard"

// The site-wide broken-image-glyph guard (2026-09-06). jsdom never loads an
// image, so the browser's post-failure verdict (`complete && naturalWidth 0`)
// is defined on the prototype per test — the same way the PackThumb pin does.

afterEach(cleanup)

function withImageVerdict<T>(complete: boolean, naturalWidth: number, fn: () => T): T {
  const proto = HTMLImageElement.prototype
  const c = Object.getOwnPropertyDescriptor(proto, "complete")
  const w = Object.getOwnPropertyDescriptor(proto, "naturalWidth")
  Object.defineProperty(proto, "complete", { configurable: true, get: () => complete })
  Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => naturalWidth })
  try { return fn() } finally {
    if (c) Object.defineProperty(proto, "complete", c)
    if (w) Object.defineProperty(proto, "naturalWidth", w)
  }
}

describe("DeadImageGuard", () => {
  it("neutralises a failed image: pixel src, marker attribute, original src kept for QA", () => {
    const img = document.createElement("img")
    img.src = "https://media.nflallday.com/editions/226/media/image?width=512"
    img.setAttribute("srcset", "https://media.nflallday.com/x 2x")
    expect(neutraliseDeadImage(img)).toBe(true)
    expect(img.getAttribute("src")).toBe(DEAD_ART_PIXEL)
    expect(img.hasAttribute("srcset")).toBe(false)
    expect(img.dataset.rpcDeadArt).toBe("1")
    expect(img.dataset.rpcDeadSrc).toContain("media.nflallday.com/editions/226")
    // idempotent — never loops on its own pixel
    expect(neutraliseDeadImage(img)).toBe(false)
  })

  it("leaves data:/blob: sources and opted-out images alone", () => {
    const a = document.createElement("img"); a.src = DEAD_ART_PIXEL
    expect(neutraliseDeadImage(a)).toBe(false)
    const b = document.createElement("img"); b.src = "https://x/y.png"; b.setAttribute("data-rpc-keep-broken", "")
    expect(neutraliseDeadImage(b)).toBe(false)
    expect(b.getAttribute("src")).toBe("https://x/y.png")
  })

  it("the mount sweep catches images that failed BEFORE hydration (complete && naturalWidth 0)", () => {
    document.body.innerHTML = `<img id="dead" src="https://storage.cloud.google.com/dl-nfl-assets-prod/tmp/PACK.png">`
    withImageVerdict(true, 0, () => {
      render(<DeadImageGuard />)
    })
    const img = document.getElementById("dead") as HTMLImageElement
    expect(img.getAttribute("src")).toBe(DEAD_ART_PIXEL)
    expect(img.dataset.rpcDeadArt).toBe("1")
  })

  it("control: a still-loading lazy image (complete === false) is NOT touched — naturalWidth 0 alone is not failure", () => {
    document.body.innerHTML = `<img id="pending" src="https://assets.nbatopshot.com/live.png" loading="lazy">`
    withImageVerdict(false, 0, () => {
      expect(sweepDeadImages()).toBe(0)
      render(<DeadImageGuard />)
    })
    const img = document.getElementById("pending") as HTMLImageElement
    expect(img.getAttribute("src")).toBe("https://assets.nbatopshot.com/live.png")
    expect(img.dataset.rpcDeadArt).toBeUndefined()
  })

  it("a future error event (capture phase) is neutralised, and the listener is removed on unmount", () => {
    document.body.innerHTML = ""
    const { unmount } = withImageVerdict(false, 0, () => render(<DeadImageGuard />))
    const img = document.createElement("img")
    img.src = "https://media.nflallday.com/editions/4607/media/image"
    document.body.appendChild(img)
    act(() => { img.dispatchEvent(new Event("error")) })
    expect(img.getAttribute("src")).toBe(DEAD_ART_PIXEL)

    unmount()
    const later = document.createElement("img")
    later.src = "https://media.nflallday.com/editions/4608/media/image"
    document.body.appendChild(later)
    act(() => { later.dispatchEvent(new Event("error")) })
    expect(later.getAttribute("src")).toBe("https://media.nflallday.com/editions/4608/media/image")
  })
})
