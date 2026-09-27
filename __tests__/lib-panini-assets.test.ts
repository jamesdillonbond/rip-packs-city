import { describe, it, expect } from "vitest"
import { paniniAssetUrl, PANINI_ASSET_BASE } from "@/lib/panini/assets"

describe("paniniAssetUrl", () => {
  it("resolves both stored path shapes on the measured host", () => {
    expect(paniniAssetUrl("pack/1038/thumbnail/pack/Soccer/2026/x_6_49.png")).toBe(PANINI_ASSET_BASE + "pack/1038/thumbnail/pack/Soccer/2026/x_6_49.png")
    expect(paniniAssetUrl("challenge/4772/038a-4083271.mp4")).toBe(PANINI_ASSET_BASE + "challenge/4772/038a-4083271.mp4")
    expect(PANINI_ASSET_BASE).toBe("https://assets.paniniamerica.net/catalog/product/")
  })

  it("encodes each segment (a space in a stored path is not a broken URL)", () => {
    expect(paniniAssetUrl("pack/a b.png")).toBe(PANINI_ASSET_BASE + "pack/a%20b.png")
  })

  it("refuses anything that is not a plain relative path — never a request to an arbitrary host", () => {
    for (const bad of [null, undefined, "", "   ", "https://evil.example/x.png", "//evil.example/x.png", "/pack/x.png", "pack/../../x.png", "javascript:alert(1)", "pack/x.png?y=<z>"]) {
      expect(paniniAssetUrl(bad as string | null | undefined), String(bad)).toBeNull()
    }
  })
})
