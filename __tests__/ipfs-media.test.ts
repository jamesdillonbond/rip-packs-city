import { describe, it, expect } from "vitest"
import { proxyIpfsUrl, proxyIpfsUrlAbsolute } from "@/lib/ipfs-media"

// Rewrites slow public IPFS-gateway art through the same-origin edge-cached
// proxy so UFC/legacy assets paint reliably. Typed CDN URLs must pass through
// untouched — a regression either breaks image loads or double-proxies.

const CID = "QmXattr123abc"

describe("proxyIpfsUrl", () => {
  it("rewrites the three proxied gateways to the same-origin path", () => {
    expect(proxyIpfsUrl(`https://ipfs.io/ipfs/${CID}`)).toBe(`/api/public/ipfs-media/${CID}`)
    expect(proxyIpfsUrl(`https://ipfs.dapperlabs.com/ipfs/${CID}`)).toBe(`/api/public/ipfs-media/${CID}`)
    expect(proxyIpfsUrl(`https://cloudflare-ipfs.com/ipfs/${CID}`)).toBe(`/api/public/ipfs-media/${CID}`)
  })

  it("passes typed CDN URLs through untouched", () => {
    const cdn = "https://assets.nbatopshot.com/media/abc/image?width=250"
    expect(proxyIpfsUrl(cdn)).toBe(cdn)
  })

  it("returns null for nullish input", () => {
    expect(proxyIpfsUrl(null)).toBeNull()
    expect(proxyIpfsUrl(undefined)).toBeNull()
    expect(proxyIpfsUrl("")).toBeNull()
  })
})

describe("proxyIpfsUrlAbsolute", () => {
  it("rewrites to a fully-qualified URL under baseUrl", () => {
    expect(
      proxyIpfsUrlAbsolute(`https://ipfs.io/ipfs/${CID}`, "https://www.rippackscity.com")
    ).toBe(`https://www.rippackscity.com/api/public/ipfs-media/${CID}`)
  })

  it("passes non-ipfs URLs through and handles null", () => {
    expect(proxyIpfsUrlAbsolute("https://cdn.example/x.png", "https://b")).toBe("https://cdn.example/x.png")
    expect(proxyIpfsUrlAbsolute(null, "https://b")).toBeNull()
  })
})
