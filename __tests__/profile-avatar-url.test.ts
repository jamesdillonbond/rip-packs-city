import { describe, it, expect } from "vitest"
import { classifyAvatarUrl, avatarUrlWarning } from "@/lib/profile/avatar-url"

// The real case: a collector pasted an OpenSea ITEM PAGE as their avatar. It is
// a perfectly valid URL that serves HTML, so nothing rejected it, nothing warned
// them, and their profile fell back to the monogram — which is indistinguishable
// from never having set an avatar. They had no way to know the value was the
// problem.

describe("marketplace page URLs — the case this exists for", () => {
  it("names OpenSea and says what to do instead", () => {
    const v = classifyAvatarUrl(
      "https://opensea.io/item/ethereum/0x5b433d6baf165b268b931f8afbb75372760e706d/2232",
    )
    expect(v.kind).toBe("marketplace-page")
    const msg = "message" in v ? v.message : ""
    // The instruction is the useful half — a warning that only says "this is
    // wrong" leaves them exactly as stuck.
    expect(msg).toMatch(/OpenSea/)
    expect(msg).toMatch(/Copy image address/i)
  })

  it("covers the other marketplaces a collector would plausibly paste", () => {
    for (const url of [
      "https://blur.io/asset/0xabc/1",
      "https://magiceden.io/item-details/xyz",
      "https://rarible.com/token/0xabc:1",
      "https://nbatopshot.com/moment/abc-123",
      "https://www.nflallday.com/moments/abc",
      "https://www.flowty.io/listing/123",
    ]) {
      expect(classifyAvatarUrl(url).kind, url).toBe("marketplace-page")
    }
  })

  it("does NOT flag an image that merely lives on a marketplace CDN", () => {
    // ⚠ THIS CASE FOUND A REAL DEFECT. The host patterns were originally
    // `(^|\.)nbatopshot\.com$`, which matches `assets.nbatopshot.com` — the CDN
    // that serves the artwork. So the warning fired on a direct image link,
    // i.e. it told the collector that the exact thing it had just asked them to
    // paste was wrong. Apex + `www.` only.
    expect(classifyAvatarUrl("https://i.seadn.io/gae/abc123?w=500").kind).toBe("ok")
    expect(classifyAvatarUrl("https://assets.nbatopshot.com/media/x.jpg").kind).toBe("ok")
    expect(classifyAvatarUrl("https://assets.nflallday.com/x/y.png").kind).toBe("ok")
    // ⚠ EXTENSIONLESS, AND THAT IS THE WHOLE POINT OF THIS LINE. The two cases
    // above end in .jpg/.png, so the image-extension short-circuit answers them
    // before the host rule is consulted — widening the host pattern back to
    // `(^|\.)nbatopshot\.com$` left them GREEN (a surviving mutation). Real CDN
    // URLs frequently carry no extension, and that is the only shape where the
    // apex-only host pattern is load-bearing.
    expect(classifyAvatarUrl("https://assets.nbatopshot.com/resize/media/abc123").kind).toBe("ok")
    // And an explicit image extension wins even on the page host itself — it is
    // not reported as a "that's a page" mistake. It is still flagged, because
    // opensea.io is not an image host our CSP paints, but with the accurate
    // reason rather than the wrong one.
    expect(classifyAvatarUrl("https://opensea.io/static/logo.png").kind).not.toBe("marketplace-page")
  })
})

describe("http:// is a real asymmetry, not pedantry", () => {
  it("warns that link previews will drop it, without calling it broken", () => {
    // app/api/og/profile/[username] gates its prefetch on startsWith("https://"),
    // so an http avatar renders on the profile and silently vanishes from the
    // social card — the one place it is seen by people not already on the site.
    const v = classifyAvatarUrl("http://example.com/me.png")
    expect(v.kind).toBe("insecure")
    const msg = "message" in v ? v.message : ""
    expect(msg).toMatch(/works on your profile/i)
    expect(msg).toMatch(/https/)
  })
})

describe("it stays quiet while you are still typing", () => {
  it("says nothing for a partially typed URL", () => {
    // A validator that scolds you on the third character is one people learn to
    // ignore, which costs more than it saves.
    for (const partial of ["h", "ht", "htt", "http", "https:", "https:/", "https://"]) {
      expect(avatarUrlWarning(partial), partial).toBeNull()
    }
  })

  it("says nothing for blank — that is the RPC-logo default, not an error", () => {
    for (const blank of ["", "   ", null, undefined]) {
      expect(classifyAvatarUrl(blank).kind).toBe("empty")
      expect(avatarUrlWarning(blank)).toBeNull()
    }
  })

  it("does flag a settled value that is clearly not a URL", () => {
    const v = classifyAvatarUrl("my profile picture.png")
    expect(v.kind).toBe("not-a-url")
    expect(avatarUrlWarning("my profile picture.png")).toMatch(/web address/i)
  })
})

describe("a host we cannot paint is not 'ok', however valid the URL", () => {
  // ⚠ THIS CORRECTS AN EARLIER VERSION OF THIS FILE, WHICH ASSERTED THAT
  // `https://example.com/me.png` WAS FINE. It is not: proxy.ts sends an
  // ENUMERATED `img-src` CSP, so an image on an unlisted host is refused by the
  // browser before a byte moves and the profile falls back to initials. The
  // validator was telling collectors a URL was good when it could never render
  // — the same shape of false reassurance the whole module exists to remove.
  it("warns for an arbitrary https image host", () => {
    for (const url of ["https://example.com/me.png", "https://cdn.example.com/a/b/c.jpg?v=2"]) {
      expect(classifyAvatarUrl(url).kind, url).toBe("unsupported-host")
      expect(avatarUrlWarning(url), url).toMatch(/can't display images from that site/i)
    }
  })

  it("points at the two things that DO work", () => {
    const msg = avatarUrlWarning("https://example.com/me.png") ?? ""
    expect(msg).toMatch(/Choose from your Moments/i)
    expect(msg).toMatch(/i\.seadn\.io/i)
  })
})

describe("a good URL passes silently", () => {
  it("returns ok for a host the CSP allows or we proxy", () => {
    for (const url of [
      "https://ipfs.io/ipfs/bafyabc123",            // in the CSP
      "https://assets.nbatopshot.com/media/x.png",  // in the CSP
      "https://i2c.seadn.io/ethereum/0xabc/d.png",  // proxied by us
      "https://www.rippackscity.com/rip-packs-city-logo.png", // 'self'
    ]) {
      expect(classifyAvatarUrl(url).kind, url).toBe("ok")
      expect(avatarUrlWarning(url), url).toBeNull()
    }
  })

  it("never throws on hostile input", () => {
    // This runs on every keystroke; a throw here blanks the editor.
    for (const junk of ["https://", "https:// ", "http://[", "https://%%%", "javascript:alert(1)"]) {
      expect(() => classifyAvatarUrl(junk)).not.toThrow()
    }
  })
})
