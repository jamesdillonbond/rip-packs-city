import { describe, it, expect } from "vitest"
import type { DasAsset } from "@/lib/chains/solana/das"
import { canonicalCandyMediaUrl, normalizeEdition } from "@/lib/chains/solana/normalize"
import { proxyIpfsImageUrl } from "@/lib/ipfs-media"

// 2026-11-16: 229 Candy editions and 6,529 holdings stored their art on https://permaweb.candy.io/<tx>.
// That host is NOT in the CSP img-src/media-src (only arweave.net + *.arweave.net), it never reached the
// arweave resizer, and its TLS certificate expired 2026-11-15 4:53 PM PT — so every one rendered as a
// broken image. The same transaction is served by arweave.net. Every writer stores the arweave.net form.
const TX = "TvXIH9PImDIb_6CpJxt9cBiMrd8I_pHsmvD-54lPDiw"

describe("Candy media URLs are stored on arweave.net, never on a Candy gateway", () => {
  it("rewrites both Candy gateways to arweave.net and leaves everything else alone", () => {
    expect(canonicalCandyMediaUrl(`https://permaweb.candy.io/${TX}`)).toBe(`https://arweave.net/${TX}`)
    expect(canonicalCandyMediaUrl(`https://candy.permaweb.services/${TX}`)).toBe(`https://arweave.net/${TX}`)
    expect(canonicalCandyMediaUrl(`https://arweave.net/${TX}`)).toBe(`https://arweave.net/${TX}`)
    // not a bare transaction id (a path inside a manifest, a short id): unchanged, never guessed
    expect(canonicalCandyMediaUrl(`https://permaweb.candy.io/${TX}/1.png`)).toBe(`https://permaweb.candy.io/${TX}/1.png`)
    expect(canonicalCandyMediaUrl("https://permaweb.candy.io/short")).toBe("https://permaweb.candy.io/short")
    expect(canonicalCandyMediaUrl("https://example.com/x.png")).toBe("https://example.com/x.png")
    expect(canonicalCandyMediaUrl(null)).toBeNull()
    expect(canonicalCandyMediaUrl("")).toBeNull()
  })

  it("an edition written from metadata naming permaweb.candy.io carries NO Candy-gateway url, and its art reaches the resizer", () => {
    const asset = {
      id: "HJbLHNtTPHyTgayShL65HSkwekdNKzW3qeuEtwanPYXD",
      content: {
        json_uri: `https://permaweb.candy.io/${TX}`,
        metadata: { name: "2023 ALCS Game 4 Houston (12/500)", attributes: [{ trait_type: "Serial Number", value: "12/500" }] },
        links: { image: `https://permaweb.candy.io/${TX}`, animation_url: `https://candy.permaweb.services/${TX}` },
      },
    } as unknown as DasAsset
    const e = normalizeEdition(asset)
    expect(e.thumbnail_url).not.toMatch(/permaweb/)
    expect(e.video_url).not.toMatch(/permaweb/)
    expect(e.thumbnail_url).toBe(`https://arweave.net/${TX}`)
    // the resized-thumbnail path recognises it (it did not for the permaweb form)
    expect(proxyIpfsImageUrl(e.thumbnail_url!, 320)).toBe(`/api/public/arweave-thumb/${TX}?w=320`)
    expect(proxyIpfsImageUrl(`https://permaweb.candy.io/${TX}`, 320)).toBe(`https://permaweb.candy.io/${TX}`)
  })
})
