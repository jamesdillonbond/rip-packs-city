import { describe, it, expect } from "vitest"
import { parallelLabelFromBadges } from "@/lib/edition-parallel"
import { editionPageMetadata } from "@/lib/seo"

// 2026-09-25 — a Candy MLB Rainbow parallel is its own edition (own mint, own
// FMV, own page) and lives ONLY in editions.badges. Six pages (Core + five
// colours) carried the identical <title> and their related tiles were four
// indistinguishable lines. The parallel now reaches the title, the description
// and the tiles through one registry.

describe("parallelLabelFromBadges", () => {
  it("names a Candy Rainbow parallel from its badge", () => {
    expect(parallelLabelFromBadges(["Rainbow (Blue)"])).toBe("Rainbow (Blue)")
    expect(parallelLabelFromBadges(["First Mint", " Rainbow (Pink) "])).toBe("Rainbow (Pink)")
  })
  it("is null for non-parallel badges, empty, null and garbage", () => {
    expect(parallelLabelFromBadges(["First Mint", "Rookie Year"])).toBeNull()
    expect(parallelLabelFromBadges([])).toBeNull()
    expect(parallelLabelFromBadges(null)).toBeNull()
    expect(parallelLabelFromBadges(undefined)).toBeNull()
    expect(parallelLabelFromBadges([null, undefined, 3 as unknown as string])).toBeNull()
    // Not in the registry: a colour the drop does not have, or a different shape.
    expect(parallelLabelFromBadges(["Rainbow (Red)"])).toBeNull()
    expect(parallelLabelFromBadges(["Rainbow Blue"])).toBeNull()
  })
})

describe("editionPageMetadata — a parallel printing gets its own title", () => {
  const base = { route_slug: "bobby-witt-jr-blue", player_name: "Bobby Witt Jr.", set_name: "2026 MLB Base Series ICONs", tier: "LEGENDARY", fmv: { fmv_usd: 136.76 } }
  it("carries the parallel in the title and the description", () => {
    const m = editionPageMetadata({ ...base, badges: ["Rainbow (Blue)"] }, "candy-mlb")
    const title = typeof m.title === "string" ? m.title : (m.title as { absolute?: string } | null)?.absolute ?? ""
    expect(title).toContain("Bobby Witt Jr. — 2026 MLB Base Series ICONs · Rainbow (Blue)")
    expect(String(m.description)).toContain("2026 MLB Base Series ICONs · Rainbow (Blue) is worth ~$137")
  })
  it("no-change control: the Core edition (no parallel badge) keeps its title", () => {
    const m = editionPageMetadata({ ...base, route_slug: "bobby-witt-jr", badges: ["First Mint"] }, "candy-mlb")
    const title = typeof m.title === "string" ? m.title : (m.title as { absolute?: string } | null)?.absolute ?? ""
    expect(title).toContain("Bobby Witt Jr. — 2026 MLB Base Series ICONs · Value")
    expect(title).not.toContain("Rainbow")
  })
  it("two colour printings never share a title", () => {
    const t = (b: string) => {
      const m = editionPageMetadata({ ...base, badges: [b] }, "candy-mlb")
      return typeof m.title === "string" ? m.title : (m.title as { absolute?: string } | null)?.absolute ?? ""
    }
    expect(t("Rainbow (Blue)")).not.toBe(t("Rainbow (Green)"))
  })
})
