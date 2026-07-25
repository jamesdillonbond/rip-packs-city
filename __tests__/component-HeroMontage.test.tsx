// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import HeroMontage from "@/components/entity/HeroMontage"

// IMAGE-WEIGHT REGRESSION GUARD (2026-07-25).
//
// This strip renders 72px tiles. Verified live: `editions.thumbnail_url` is an
// IPFS master for 10,289 of the 12,920 Top Shot editions that have art and for
// 518/518 UFC ones, and those CIDs measure 3.87–4.66 MB at 2880×2880. The IPFS
// gateways ignore `?width=`, so the ONLY way a 72px tile avoids a multi-megabyte
// download is Top Shot's sized per-moment derivative
// (`assets.nbatopshot.com/media/<nft_id>/image?width=N`, 2,716 bytes at 144).
// These tests pin that the sized source wins for Top Shot, that the IPFS proxy
// remains a working fallback, and that the strip never re-arms fetchPriority=high
// (5 high-priority 4 MB fetches is what made hero tiles paint blank/broken).
afterEach(cleanup)

const TS_ITEMS = [
  { thumbnail_url: "https://ipfs.dapperlabs.com/ipfs/QmAAA", name: "LaMelo Ball — Crunch Time", rep_nft_id: "45663101" },
  { thumbnail_url: "https://ipfs.dapperlabs.com/ipfs/QmBBB", name: "Kevin Durant — Crunch Time", rep_nft_id: "45381151" },
]

describe("HeroMontage image weight", () => {
  it("prefers the sized Top Shot derivative over the IPFS master", () => {
    const { container } = render(<HeroMontage items={TS_ITEMS} collectionUrlSlug="nba-top-shot" />)
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))
    expect(srcs).toEqual([
      "https://assets.nbatopshot.com/media/45663101/image?width=144",
      "https://assets.nbatopshot.com/media/45381151/image?width=144",
    ])
    // No src may be a raw IPFS master or the un-resizable same-origin proxy.
    for (const s of srcs) expect(s).not.toMatch(/ipfs/)
  })

  it("requests 2x the 72px tile, not the 400px grid width", () => {
    const { container } = render(<HeroMontage items={TS_ITEMS} collectionUrlSlug="nba-top-shot" />)
    const src = container.querySelector("img")!.getAttribute("src")!
    expect(src).toContain("width=144")
    expect(src).not.toContain("width=400")
  })

  it("does not mark the decorative strip as high fetch priority", () => {
    const { container } = render(<HeroMontage items={TS_ITEMS} collectionUrlSlug="nba-top-shot" />)
    for (const img of container.querySelectorAll("img")) {
      expect(img.getAttribute("fetchpriority")).not.toBe("high")
    }
  })

  it("keeps intrinsic dimensions so tile layout is reserved before paint", () => {
    const { container } = render(<HeroMontage items={TS_ITEMS} collectionUrlSlug="nba-top-shot" />)
    const img = container.querySelector("img")!
    expect(img.getAttribute("width")).toBe("72")
    expect(img.getAttribute("height")).toBe("72")
    expect(img.getAttribute("decoding")).toBe("async")
  })

  it("demotes to the IPFS proxy — not a dead tile — when the sized URL 404s", () => {
    const { container } = render(<HeroMontage items={TS_ITEMS} collectionUrlSlug="nba-top-shot" />)
    fireEvent.error(container.querySelectorAll("img")[0])
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))
    // Tile survives, now served from the proxy; sibling untouched.
    expect(srcs).toEqual([
      "/api/public/ipfs-media/QmAAA",
      "https://assets.nbatopshot.com/media/45381151/image?width=144",
    ])
  })

  it("prunes the tile when the fallback also fails", () => {
    const { container } = render(<HeroMontage items={TS_ITEMS} collectionUrlSlug="nba-top-shot" />)
    fireEvent.error(container.querySelectorAll("img")[0])
    fireEvent.error(container.querySelectorAll("img")[0])
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))
    expect(srcs).toEqual(["https://assets.nbatopshot.com/media/45381151/image?width=144"])
  })

  it("non-Top-Shot collections still render via the IPFS proxy", () => {
    const { container } = render(
      <HeroMontage
        items={[{ thumbnail_url: "https://ipfs.io/ipfs/QmUFC", name: "x", rep_nft_id: "999" }]}
        collectionUrlSlug="ufc"
      />,
    )
    expect(container.querySelector("img")!.getAttribute("src")).toBe("/api/public/ipfs-media/QmUFC")
  })

  it("renders nothing when there are no thumbnails", () => {
    const { container } = render(
      <HeroMontage items={[{ thumbnail_url: null, name: "x" }]} collectionUrlSlug="nba-top-shot" />,
    )
    expect(container.querySelectorAll("img")).toHaveLength(0)
  })
})
