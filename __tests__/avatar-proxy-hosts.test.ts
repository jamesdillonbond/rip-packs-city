import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  PROXYABLE_AVATAR_HOSTS,
  PROXY_CONTENT_TYPES,
  isProxyableAvatarUrl,
  avatarDisplayUrl,
} from "@/lib/media/avatar-proxy"

// The host allowlist IS the SSRF guard for /api/public/avatar-media, exactly as
// the CID regex is for /api/public/ipfs-media. Everything below is about the
// boundary of that set.

describe("what gets proxied", () => {
  it("proxies an NFT CDN the CSP does not allow", () => {
    const src = "https://i2c.seadn.io/ethereum/0xabc/def/ghi.png?w=500"
    expect(isProxyableAvatarUrl(src)).toBe(true)
    expect(avatarDisplayUrl(src)).toBe(
      `/api/public/avatar-media?src=${encodeURIComponent(src)}`,
    )
  })

  it("passes through a host the CSP ALREADY allows, adding no hop", () => {
    // Hotlinking works for these, so routing them through the proxy would add a
    // dependency and break avatars that work today if the route ever faults.
    const src = "https://assets.nbatopshot.com/media/x.png"
    expect(isProxyableAvatarUrl(src)).toBe(false)
    expect(avatarDisplayUrl(src)).toBe(src)
  })

  it("passes through our own default logo untouched", () => {
    const logo = "https://www.rippackscity.com/rip-packs-city-logo.png"
    expect(avatarDisplayUrl(logo)).toBe(logo)
  })

  it("encodes the src so a crafted URL cannot inject extra query params", () => {
    const nasty = "https://i.seadn.io/a.png?x=1&src=https://evil.example/b.png"
    const out = avatarDisplayUrl(nasty)
    // Exactly one `src=` parameter, and the `&` inside the value is escaped.
    expect(out.match(/src=/g)).toHaveLength(1)
    expect(out).not.toContain("&src=https")
  })
})

describe("the SSRF boundary", () => {
  it("refuses a host that merely CONTAINS or ENDS WITH an allowlisted one", () => {
    // The classic suffix-match bypass. Exact hostname matching is what stops it.
    //
    // ⚠ THE `endsWith` CASES ARE THE ONES THAT MATTER, AND THEY WERE MISSING —
    // a mutation swapping `includes(hostname)` for `some(h => hostname.endsWith(h))`
    // SURVIVED the first version of this test, because every fixture here ended
    // in some OTHER domain. `evilarweave.net` is the case with teeth: it ends
    // with an allowlisted host and anyone can register it, so a suffix match
    // would have handed an attacker-controlled origin straight to the fetch.
    for (const bad of [
      "https://i.seadn.io.evil.example/a.png",
      "https://evil-i.seadn.io.attacker.test/a.png",
      "https://notseadn.io/a.png",
      // ── endsWith bypasses ──
      "https://evilarweave.net/a.png",
      "https://xarweave.net/a.png",
      "https://xi.seadn.io/a.png",
      "https://evil.arweave.net.attacker.test/a.png",
    ]) {
      expect(isProxyableAvatarUrl(bad), bad).toBe(false)
      expect(avatarDisplayUrl(bad)).toBe(bad)
    }
  })

  it("refuses userinfo trickery — the host is what follows the @", () => {
    // `https://i.seadn.io@evil.example/` parses with hostname evil.example.
    // Reading the string left-to-right would see an allowlisted host.
    expect(isProxyableAvatarUrl("https://i.seadn.io@evil.example/a.png")).toBe(false)
  })

  it("refuses http, so a cleartext fetch is never laundered into an https response", () => {
    expect(isProxyableAvatarUrl("http://i.seadn.io/a.png")).toBe(false)
  })

  it("refuses private, loopback and metadata addresses outright", () => {
    // Not reachable via the allowlist anyway — asserted because these are what
    // an SSRF is FOR, and a future widening of the host rule must not admit them.
    for (const bad of [
      "https://127.0.0.1/a.png",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/a.png",
      "https://localhost/a.png",
      "https://[::1]/a.png",
    ]) {
      expect(isProxyableAvatarUrl(bad), bad).toBe(false)
    }
  })

  it("refuses non-http schemes and unparseable input without throwing", () => {
    for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAA", "file:///etc/passwd", "://", "", null, undefined]) {
      expect(() => isProxyableAvatarUrl(bad as never)).not.toThrow()
      expect(isProxyableAvatarUrl(bad as never)).toBe(false)
    }
  })
})

describe("content types", () => {
  it("EXCLUDES svg — an SVG served same-origin is a stored-XSS vector", () => {
    // The single most important assertion in this file. An SVG is a document
    // that can carry <script>; serving one from our origin makes it same-origin
    // with the session. Every other permitted type is inert.
    expect(PROXY_CONTENT_TYPES).not.toContain("image/svg+xml")
    expect(PROXY_CONTENT_TYPES.some((t) => t.includes("svg"))).toBe(false)
  })

  it("permits only inert raster types", () => {
    for (const t of PROXY_CONTENT_TYPES) expect(t).toMatch(/^image\/(png|jpeg|gif|webp|avif)$/)
  })
})

describe("the allowlist and the CSP stay disjoint", () => {
  it("no proxyable host is already named in proxy.ts img-src", () => {
    // Parsed from the real file, so adding a host to one list and forgetting the
    // other is caught rather than silently double-handled. If a host is in BOTH,
    // we would be proxying something that already renders hotlinked.
    const proxySrc = fs.readFileSync(path.join(process.cwd(), "proxy.ts"), "utf8")
    const imgSrc = proxySrc.match(/"img-src ([^"]+)"/)
    expect(imgSrc, "img-src directive not found in proxy.ts").toBeTruthy()
    const cspHosts = [...imgSrc![1].matchAll(/https:\/\/([^\s]+)/g)].map((m) => m[1])
    const overlap = PROXYABLE_AVATAR_HOSTS.filter((h) => cspHosts.includes(h))
    expect(overlap, `hosts in BOTH the CSP and the proxy allowlist: ${overlap.join(", ")}`).toEqual([])
  })

  it("the CSP genuinely does not carry the NFT hosts — the reason this exists", () => {
    // If this ever fails, someone widened img-src and the proxy's rationale
    // changed; re-read the module header before assuming it is still needed.
    const proxySrc = fs.readFileSync(path.join(process.cwd(), "proxy.ts"), "utf8")
    const imgSrc = proxySrc.match(/"img-src ([^"]+)"/)![1]
    expect(imgSrc).not.toContain("seadn.io")
    // …and 'self' IS there, which is what makes proxying work at all.
    expect(imgSrc).toContain("'self'")
  })
})

// ── ARWEAVE IS A CSP HOST, NOT A PROXYABLE ONE (2026-09-04) ────────────────
//
// It was in `PROXYABLE_AVATAR_HOSTS` and it could NEVER work there. Verified in
// production first: `/insights/top-sales` rendered two `<img>` at
// `naturalWidth = 0`, and the proxy answered 502.
//
//   1. `arweave.net` ALWAYS 302s to a content-addressed subdomain, and
//      /api/public/avatar-media refuses redirects as its SSRF guard.
//   2. Following that redirect would not have helped: the asset measured
//      6,872,443 bytes against MAX_AVATAR_BYTES = 4,194,304.
//
// So it moved to the CSP and now hotlinks, exactly as ipfs.io does. The
// disjointness test above stops the two halves drifting apart; these pin that
// the move actually HAPPENED, which disjointness alone cannot see — removing it
// from both lists would satisfy disjointness and leave the art blank.
describe("Arweave art hotlinks rather than proxying", () => {
  const imgSrc = () => {
    const src = fs.readFileSync(path.join(process.cwd(), "proxy.ts"), "utf8")
    const m = src.match(/"img-src ([^"]+)"/)
    expect(m, "img-src directive not found in proxy.ts").toBeTruthy()
    return m![1]
  }

  it("names arweave.net AND its content subdomains in img-src", () => {
    // Both, deliberately: the browser follows the 302 itself, and the redirect
    // target is a per-asset subdomain that an exact host cannot cover.
    expect(imgSrc()).toContain("https://arweave.net")
    expect(imgSrc()).toContain("https://*.arweave.net")
  })

  it("does NOT proxy it — avatarDisplayUrl passes an Arweave URL through unchanged", () => {
    const src = "https://arweave.net/iKT2pAHeP1QA1jZn_HHigZzs0dPOHrq_5_2KD9xUZjU"
    expect(isProxyableAvatarUrl(src)).toBe(false)
    expect(avatarDisplayUrl(src)).toBe(src)
  })

  it("still proxies the seadn hosts, which the CSP genuinely does not carry", () => {
    // The control. Without it, deleting the whole allowlist would pass the case
    // above and silently stop proxying everything.
    expect(isProxyableAvatarUrl("https://i2c.seadn.io/x/y.png")).toBe(true)
    expect(imgSrc()).not.toContain("seadn.io")
  })
})
