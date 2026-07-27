// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import { getImageUrl, getVideoUrl } from "@/components/MomentMedia"

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
