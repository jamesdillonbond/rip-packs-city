// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import MomentMedia, { getImageUrl, getVideoUrl } from "@/components/MomentMedia"

// getImageUrl/getVideoUrl derive the rendered art URL. The bare-IPFS-gateway
// guard exists because appending TopShot's Hero_/Animated_ suffixes to a public
// gateway URL produced BROKEN art (pre-2022 Series-1 + UFC moments).

describe("getImageUrl", () => {
  it("routes a bare IPFS-gateway URL through the same-origin proxy AS-IS (no Hero suffix)", () => {
    const out = getImageUrl("https://ipfs.io/ipfs/QmABC123")
    expect(out).toBe("/api/public/ipfs-media/QmABC123")
    expect(out).not.toContain("Hero_")
  })
  it("guards ipfs.dapperlabs.com and cloudflare-ipfs.com too", () => {
    expect(getImageUrl("https://ipfs.dapperlabs.com/ipfs/QmXYZ")).toBe("/api/public/ipfs-media/QmXYZ")
  })
  it("returns an already-extensioned image URL unchanged", () => {
    expect(getImageUrl("https://cdn/x.png")).toBe("https://cdn/x.png")
    expect(getImageUrl("https://cdn/x.webp")).toBe("https://cdn/x.webp")
  })
  it("builds the TopShot resize URL with the Hero suffix for an assets prefix", () => {
    const out = getImageUrl("https://assets.nbatopshot.com/editions/abc/")
    expect(out).toContain("https://assets.nbatopshot.com/resize/editions/abc/")
    expect(out).toContain("Hero_2880_2880_Transparent.png")
    expect(out).toContain("width=600")
  })
  it("null/undefined → null", () => {
    expect(getImageUrl(null)).toBeNull()
    expect(getImageUrl(undefined)).toBeNull()
  })
})

describe("getVideoUrl", () => {
  it("bare IPFS-gateway → null (no derivable animated variant)", () => {
    expect(getVideoUrl("https://ipfs.io/ipfs/QmABC")).toBeNull()
  })
  it("an .mp4 passes through; an image extension → null", () => {
    expect(getVideoUrl("https://cdn/x.mp4")).toBe("https://cdn/x.mp4")
    expect(getVideoUrl("https://cdn/x.png")).toBeNull()
  })
  it("builds the Animated_ mp4 for a TopShot prefix", () => {
    expect(getVideoUrl("https://assets.nbatopshot.com/editions/abc/")).toBe(
      "https://assets.nbatopshot.com/editions/abc/Animated_1080_1080_Black.mp4",
    )
  })
  it("null → null", () => {
    expect(getVideoUrl(null)).toBeNull()
  })
})

// The <MomentMedia> render body (img/video mount ordering + the hover play/pause
// effect) is distinct from the pure URL helpers above; jsdom doesn't implement
// HTMLMediaElement.play/pause, so stub them so the hover effect's
// v.play().catch() and v.pause() run without "Not implemented" noise.
describe("MomentMedia render", () => {
  let play: ReturnType<typeof vi.fn>
  let pause: ReturnType<typeof vi.fn>
  beforeEach(() => {
    play = vi.fn(() => Promise.resolve())
    pause = vi.fn()
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as unknown as () => Promise<void>)
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause as unknown as () => void)
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("mounts BOTH an <img> and a <video> for a TopShot assets prefix, and hover plays/pauses the clip", () => {
    const { container } = render(
      <MomentMedia thumbnailUrl="https://assets.nbatopshot.com/editions/abc/" alt="hero" size={120} />,
    )
    const img = container.querySelector("img")
    const video = container.querySelector("video")
    expect(img).toBeTruthy()
    expect(video).toBeTruthy()
    expect(img?.getAttribute("alt")).toBe("hero")
    const wrap = container.firstElementChild as HTMLElement
    fireEvent.mouseEnter(wrap)
    expect(play).toHaveBeenCalled() // hover=true -> effect plays
    fireEvent.mouseLeave(wrap)
    expect(pause).toHaveBeenCalled() // hover=false -> pause + rewind
  })

  it("renders only an <img> (no video) for an already-extensioned image URL", () => {
    const { container } = render(<MomentMedia thumbnailUrl="https://cdn/x.png" />)
    expect(container.querySelector("img")).toBeTruthy()
    expect(container.querySelector("video")).toBeNull()
  })

  it("routes a bare IPFS-gateway thumbnail through the proxy <img> with no video", () => {
    const { container } = render(<MomentMedia thumbnailUrl="https://ipfs.io/ipfs/QmABC" />)
    const img = container.querySelector("img")
    expect(img?.getAttribute("src")).toBe("/api/public/ipfs-media/QmABC")
    expect(container.querySelector("video")).toBeNull()
  })

  it("renders a bare placeholder (no img, no video) when the thumbnail is null", () => {
    const { container } = render(<MomentMedia thumbnailUrl={null} />)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("video")).toBeNull()
    // The wrapper still renders (aspect-ratio box) with the default background.
    expect(container.firstElementChild).toBeTruthy()
  })
})
