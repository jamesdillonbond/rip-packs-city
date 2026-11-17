import { describe, it, expect } from "vitest"
import { checkAccentColor, checkAvatarUrl, checkUsername } from "@/lib/profile/bio-input"

// CISO pass 2026-11-04 (API authorization findings 1 and 8). Each refusal is a PLANTED
// defect that POST/PATCH /api/profile/bio accepted before this module existed.
describe("checkUsername", () => {
  it("lowercases and accepts the handle shape the Top Shot auto-claim uses", () => {
    expect(checkUsername("Webz_80")).toEqual({ ok: true, value: "webz_80" })
    expect(checkUsername("  tomwagmi ")).toEqual({ ok: true, value: "tomwagmi" })
  })
  it("refuses a squat-shaped or unrenderable handle", () => {
    for (const bad of ["ab", "a".repeat(33), "trevor's", "tre%", "<script>", "admin", "rippackscity", "", 42, null]) {
      expect(checkUsername(bad).ok, String(bad)).toBe(false)
    }
  })
})

describe("checkAccentColor", () => {
  it("accepts hex and treats blank as unset", () => {
    expect(checkAccentColor("#E03A2F")).toEqual({ ok: true, value: "#E03A2F" })
    expect(checkAccentColor("")).toEqual({ ok: true, value: null })
  })
  it("refuses anything that is not a hex colour (it is rendered into an inline style)", () => {
    for (const bad of ["red", "#E03A2F; background:url(x)", "url(javascript:1)", "expression(1)"]) expect(checkAccentColor(bad).ok, bad).toBe(false)
  })
})

describe("checkAvatarUrl", () => {
  it("accepts a CSP-displayable https image or a same-origin path", () => {
    expect(checkAvatarUrl("https://assets.nbatopshot.com/x.png").ok).toBe(true)
    expect(checkAvatarUrl("/avatars/me.png").ok).toBe(true)
    expect(checkAvatarUrl(null)).toEqual({ ok: true, value: null })
  })
  it("refuses hosts the server must never fetch and schemes it must never render", () => {
    for (const bad of ["http://evil.example/a.png", "https://evil.example/a.png", "javascript:alert(1)", "data:image/svg+xml;base64,AAAA", "https://169.254.169.254/latest/meta-data"]) {
      expect(checkAvatarUrl(bad).ok, bad).toBe(false)
    }
  })
})
