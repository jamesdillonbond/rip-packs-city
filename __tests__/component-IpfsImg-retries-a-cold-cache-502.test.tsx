// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, act } from "@testing-library/react"
import IpfsImg from "@/components/media/IpfsImg"
import { IPFS_RETRY_DELAY_MS } from "@/lib/media/use-ipfs-retry"

// ── THE MARKET PAGE'S IMAGES RETRY A COLD-CACHE 502 ────────────────────────
//
// ⚠ MEASURED IN PRODUCTION, not inferred. `/nba-top-shot/market` on 2026-09-04:
// **12 of 15 `/api/public/ipfs-media/` images returned 502 and rendered blank** —
// an 80% failure rate on a public page. The same CID three times: 502 (8.16s),
// 502 (8.13s), **200 (0.49s, 2.58 MB)**; upstream ipfs.io answered 504 after
// 28.6s. The art is fine — the first visitor to a cold CID pays the route's
// deliberate 8s headers budget and an <img> never retries a 502 on its own.
//
// ⭐ The retry ALREADY EXISTED (`lib/media/use-ipfs-retry.ts`) and was wired to
// the edition page and /insights/trophies — but not to the market page, which is
// the one rendering fifteen of these at once. This pins the wiring.
//
// ⚠ Why a WRAPPER and not `components/entity/IpfsThumb`: that component owns its
// layout (square box, fixed aspect ratio, margin, text fallback). The market
// page's two sites are an objectFit-cover fill and an 80×80 table cell, so using
// it would have changed the page's layout in order to fix a broken image.

afterEach(() => vi.useRealTimers())

describe("IpfsImg", () => {
  it("re-mounts the <img> after the first error, WITHOUT cache-busting the URL", () => {
    vi.useFakeTimers()
    const src = "/api/public/ipfs-media/bafyTEST"
    const { container } = render(<IpfsImg src={src} alt="art" />)
    const first = container.querySelector("img")!
    expect(first.getAttribute("src")).toBe(src)

    act(() => { first.dispatchEvent(new Event("error")) })
    act(() => { vi.advanceTimersByTime(IPFS_RETRY_DELAY_MS + 10) })

    const second = container.querySelector("img")!
    // ⛔ The URL must be IDENTICAL. A `?t=` buster would miss our edge cache and
    // re-run the cold upstream fetch that just timed out — turning a
    // one-visitor defect into an every-visitor one.
    expect(second.getAttribute("src")).toBe(src)

    // 🚨 THE LOAD-BEARING ASSERTION, and it was MISSING until a mutation exposed
    // it. Removing `key={key}` from the component left every other case here
    // green, because a React key is not visible in the DOM — yet the key IS the
    // whole mechanism: without a remount React reuses the same <img> node and the
    // browser never re-requests, so the "retry" retries nothing.
    // A key change unmounts and remounts, producing a DIFFERENT DOM node.
    expect(second).not.toBe(first)
  })

  it("gives up after the SECOND error and renders nothing, not a broken glyph", () => {
    vi.useFakeTimers()
    const { container } = render(<IpfsImg src="/api/public/ipfs-media/bafyTEST" alt="art" />)
    act(() => { container.querySelector("img")!.dispatchEvent(new Event("error")) })
    act(() => { vi.advanceTimersByTime(IPFS_RETRY_DELAY_MS + 10) })
    act(() => { container.querySelector("img")!.dispatchEvent(new Event("error")) })
    expect(container.querySelector("img")).toBeNull()
  })

  it("passes the caller's sizing through untouched — the reason this is not IpfsThumb", () => {
    // The control against a 'fix' that silently restyles the page.
    const { container } = render(
      <IpfsImg src="/api/public/ipfs-media/bafyTEST" alt="" width={80} height={80} style={{ borderRadius: 8, objectFit: "cover" }} />,
    )
    const img = container.querySelector("img")!
    expect(img.getAttribute("width")).toBe("80")
    expect(img.getAttribute("height")).toBe("80")
    expect(img.style.borderRadius).toBe("8px")
    expect(img.style.objectFit).toBe("cover")
    expect(img.getAttribute("loading")).toBe("lazy")
  })

  it("renders nothing for a missing src", () => {
    const { container } = render(<IpfsImg src={undefined} alt="" />)
    expect(container.querySelector("img")).toBeNull()
  })
})
