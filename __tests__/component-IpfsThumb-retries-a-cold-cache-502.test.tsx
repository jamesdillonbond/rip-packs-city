// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, act, cleanup } from "@testing-library/react"
import IpfsThumb from "@/components/entity/IpfsThumb"

// ── The cold-CID 502 is a miss, not a dead image (2026-09-04) ────────────────
// /api/public/ipfs-media/<cid> aborts at its deliberate 8s HEADERS_TIMEOUT_MS and returns 502 on a
// COLD CID; every request after that succeeds in well under a second. Measured in production,
// three requests each against the parallel art on /nba-top-shot/edition/98:3150::5:
//     QmbA28D3qsmYxVg49tXu…   502 (8.17s)   200 (0.36s)   200 (0.36s)
// So the FIRST visitor to each CID — and only they — saw a permanently broken image, because an
// <img> never retries a 502 on its own. Verified in a real browser that those three 169×169 tiles
// had `hasOnError: false`, i.e. the route's documented "<img onError> chain" did not exist here.
//
// These cases pin the three behaviours that matter: it retries exactly once, it stops after that
// rather than hammering, and the retry re-requests the SAME url (a cache-buster would miss our
// edge cache and re-run the very fetch that just timed out).
describe("IpfsThumb — one retry on a cold-cache 502, then an honest label", () => {
  afterEach(() => { cleanup(); vi.useRealTimers() })

  const SRC = "/api/public/ipfs-media/QmbA28D3qsmYxVg49tXu3AfPoE8VurJyoaVgEb3SBtBQyu"

  it("retries once with the same url, and the retried image is what the reader sees", async () => {
    vi.useFakeTimers()
    render(<IpfsThumb src={SRC} alt="Coded" label="Coded" />)

    const first = screen.getByAltText("Coded") as HTMLImageElement
    expect(first.getAttribute("src")).toBe(SRC)

    await act(async () => { first.dispatchEvent(new Event("error")) })
    await act(async () => { vi.advanceTimersByTime(1500) })

    const retried = screen.getByAltText("Coded") as HTMLImageElement
    // same URL — never a cache-busted one, which would miss the edge cache
    expect(retried.getAttribute("src")).toBe(SRC)
    expect(retried.getAttribute("src")).not.toContain("?")
  })

  it("gives up after the retry and says so, instead of a broken-image icon", async () => {
    vi.useFakeTimers()
    render(<IpfsThumb src={SRC} alt="Coded" label="Coded" />)

    await act(async () => { screen.getByAltText("Coded").dispatchEvent(new Event("error")) })
    await act(async () => { vi.advanceTimersByTime(1500) })
    await act(async () => { screen.getByAltText("Coded").dispatchEvent(new Event("error")) })

    expect(screen.queryByAltText("Coded")).toBeNull()
    expect(screen.getByText("Coded")).toBeTruthy()
  })

  it("a null src renders the label immediately and never an empty <img>", () => {
    render(<IpfsThumb src={null} alt="Halftone" label="Halftone" />)
    expect(screen.queryByRole("img")).toBeNull()
    expect(screen.getByText("Halftone")).toBeTruthy()
  })

  it("an image that loads is left alone", () => {
    render(<IpfsThumb src={SRC} alt="Bubbled" label="Bubbled" />)
    const img = screen.getByAltText("Bubbled") as HTMLImageElement
    expect(img.getAttribute("loading")).toBe("lazy")
    expect(screen.queryByText("Bubbled")).toBeNull()
  })
})
