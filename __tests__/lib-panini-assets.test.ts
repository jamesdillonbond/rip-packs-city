import { describe, it, expect } from "vitest"
import { paniniAssetUrl, PANINI_ASSET_BASE } from "@/lib/panini/assets"

describe("paniniAssetUrl", () => {
  it("resolves both stored path shapes on the measured host", () => {
    expect(paniniAssetUrl("pack/1038/thumbnail/pack/Soccer/2026/x_6_49.png")).toBe(PANINI_ASSET_BASE + "pack/1038/thumbnail/pack/Soccer/2026/x_6_49.png")
    expect(paniniAssetUrl("challenge/4772/038a-4083271.mp4")).toBe(PANINI_ASSET_BASE + "challenge/4772/038a-4083271.mp4")
    expect(PANINI_ASSET_BASE).toBe("https://assets.paniniamerica.net/catalog/product/")
  })

  it("is idempotent — a URL already on the Panini base (editions since 20260927190000) passes through", () => {
    const u = PANINI_ASSET_BASE + "pack/1038/thumbnail/x.png"
    expect(paniniAssetUrl(u)).toBe(u)
    expect(paniniAssetUrl(paniniAssetUrl("pack/x.png"))).toBe(PANINI_ASSET_BASE + "pack/x.png")
    expect(paniniAssetUrl(PANINI_ASSET_BASE + "../x.png")).toBeNull()
    expect(paniniAssetUrl(PANINI_ASSET_BASE + "//evil.example/x.png")).toBeNull()
  })

  it("matches the SQL twin's character set — a space is refused (no stored path has one)", () => {
    expect(paniniAssetUrl("pack/a b.png")).toBeNull()
  })

  it("refuses anything that is not a plain relative path — never a request to an arbitrary host", () => {
    for (const bad of [null, undefined, "", "   ", "https://evil.example/x.png", "//evil.example/x.png", "/pack/x.png", "pack/../../x.png", "javascript:alert(1)", "pack/x.png?y=<z>"]) {
      expect(paniniAssetUrl(bad as string | null | undefined), String(bad)).toBeNull()
    }
  })
})
