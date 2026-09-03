import { describe, it, expect } from "vitest"
import { sanitizeTrophyThumbnail } from "@/lib/profile/trophy-thumbnail"

// ─────────────────────────────────────────────────────────────────────────────
// A pinned trophy is published on a PUBLIC profile and baked into a shared PNG.
// What the client may assert about it is therefore a security question, not a
// validation nicety.
//
// ── THE FINDING, AS FILED AND AS RE-DERIVED ─────────────────────────────────
// docs/handoff-2026-09-02-onboarding-trophy-case-qa.md #7 reports that
// `POST /api/profile/trophy` upserts `playerName`, `fmv`, `serialNumber`,
// `tier`, `thumbnailUrl` "straight from the request body with no ownership
// check", and recommends resolving every display field server-side.
//
// ⭐ RE-DERIVED BEFORE ACTING, AND THE SCOPE IS MUCH NARROWER — which is the
// point of the rule. `get_trophy_slab_data` renders public slabs with
// `COALESCE(e.<field>, tm.<field>)` and `COALESCE(f.fmv_usd, tm.fmv)`, so the
// live `editions` / `fmv_snapshots` values WIN and a forged player, set, tier,
// circulation, video, FMV or badge list is overridden as soon as the edition
// resolves. **Acting on the filing as written would have been ~80% redundant
// work.** Two stored fields are not coalesced and are published as submitted:
//
//   serial_number   — "#1 of 15,000" IS the trophy; it was taken from the body
//   thumbnail_url   — rendered publicly AND fetched server-side by
//                     /api/og/profile/[username], which inlines it as a data URI
//
// ⚠ NOT AN INCIDENT. Measured 2026-09-03: 19 trophy rows across 7 users, every
// thumbnail on a legitimate host (assets.nbatopshot.com 16, media.nflallday.com
// 2, one same-origin Pinnacle proxy path). This closes a latent vector before a
// campaign points users at it.
// ─────────────────────────────────────────────────────────────────────────────

describe("trophy art is allowlisted, not accepted", () => {
  it("keeps the hosts our own catalogue actually serves", () => {
    // Derived from `editions.thumbnail_url`, not guessed — the query and the row
    // counts are in the module header. A guessed list silently blanks the art of
    // whichever host it forgot.
    for (const url of [
      "https://assets.nbatopshot.com/media/abc/image?width=512",
      "https://media.nflallday.com/media/def/image",
      "https://ipfs.dapperlabs.com/ipfs/Qm123",
      "https://assets.laligagolazos.com/x.png",
      "https://ipfs.io/ipfs/Qm456",
      "https://arweave.net/abc",
      "https://storage.googleapis.com/bucket/x.png",
    ]) {
      expect(sanitizeTrophyThumbnail(url), url).toBe(url)
    }
  })

  it("keeps the same-origin Pinnacle proxy path, which a host-only list would reject", () => {
    // Disney Pinnacle art is served by our own route, and one live row uses it.
    const p = "/api/public/pinnacle-image/LEV2-LION-CARE-S6"
    expect(sanitizeTrophyThumbnail(p)).toBe(p)
  })

  it("REJECTS an attacker-chosen host — the vector this exists for", () => {
    expect(sanitizeTrophyThumbnail("https://evil.example.com/pwn.png")).toBeNull()
    // A lookalike host must not pass on a substring: it is a hostname SET, not
    // a `.includes()`.
    expect(sanitizeTrophyThumbnail("https://assets.nbatopshot.com.evil.example/x")).toBeNull()
    expect(sanitizeTrophyThumbnail("https://evil.example/assets.nbatopshot.com/x")).toBeNull()
  })

  it("REJECTS the schemes that turn an <img src> into something else", () => {
    expect(sanitizeTrophyThumbnail("javascript:alert(1)")).toBeNull()
    expect(sanitizeTrophyThumbnail("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull()
    // http is downgrade-able even on an allowed host.
    expect(sanitizeTrophyThumbnail("http://assets.nbatopshot.com/x.png")).toBeNull()
  })

  it("REJECTS a protocol-relative URL — an absolute URL wearing a relative disguise", () => {
    // `//evil.com/x.png` resolves to https://evil.com/x.png in a browser, so a
    // naive "starts with /" check would have let it straight through. This is
    // the case that makes the same-origin branch a prefix test rather than a
    // slash test.
    expect(sanitizeTrophyThumbnail("//evil.example/x.png")).toBeNull()
  })

  it("REJECTS a same-origin path outside the public image proxy", () => {
    // A bare "/" allowance would let a pin point at any internal route.
    expect(sanitizeTrophyThumbnail("/api/profile/trophy")).toBeNull()
    expect(sanitizeTrophyThumbnail("/dashboard")).toBeNull()
  })

  it("handles absent and non-string input without throwing", () => {
    expect(sanitizeTrophyThumbnail(undefined)).toBeNull()
    expect(sanitizeTrophyThumbnail(null)).toBeNull()
    expect(sanitizeTrophyThumbnail(42)).toBeNull()
    expect(sanitizeTrophyThumbnail("   ")).toBeNull()
    expect(sanitizeTrophyThumbnail("not a url at all")).toBeNull()
  })

  it("the route calls the sanitizer instead of storing the body value", async () => {
    // A perfect sanitizer is inert if the handler still writes `thumbnailUrl`.
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const src = readFileSync(join(process.cwd(), "app/api/profile/trophy/route.ts"), "utf8")
    expect(src).toMatch(/thumbnail_url:\s*sanitizeTrophyThumbnail\(thumbnailUrl\)/)
    expect(src).not.toMatch(/thumbnail_url:\s*thumbnailUrl\s*\?\?/)
    // …and the serial prefers the value resolved from the moment index.
    expect(src).toMatch(/serial_number:\s*verifiedSerial\s*\?\?\s*serialNumber/)
  })
})
