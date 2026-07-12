import { describe, it, expect } from "vitest"
import { buildContext } from "@/lib/hooks/useCollectionContext"
import { lookupBadge, classesForColorFamily, COLOR_FAMILY_CLASSES } from "@/lib/badges/useBadgeTaxonomy"
import { normalizeBadgeKey } from "@/lib/badges/normalize"

// The pure cores behind two client hooks: buildContext (canonical collection
// context — accent fallback, hasPage, pre-bound marketplace URLs) and the badge
// taxonomy lookup + color mapping. Tested directly, no React Testing Library.

describe("buildContext", () => {
  it("resolves a known collection with its pages + pre-bound URLs", () => {
    const ctx = buildContext("nba-top-shot")
    expect(ctx.collection?.id).toBe("nba-top-shot")
    expect(ctx.collectionId).toBe("nba-top-shot")
    expect(ctx.published).toBe(true)
    expect(ctx.accent).toBeTruthy()
    expect(ctx.hasPage("overview")).toBe(true)
    expect(ctx.momentUrl("9")).toBe("https://nbatopshot.com/moment/9")
    expect(ctx.walletUrl("0xabc")).toBe("https://nbatopshot.com/user/0xabc")
  })

  it("falls back for an unknown collection (null collection, brand accent, no pages)", () => {
    const ctx = buildContext("not-a-collection")
    expect(ctx.collection).toBeNull()
    expect(ctx.published).toBe(false)
    expect(ctx.accent).toBe("#E03A2F")
    expect(ctx.supabaseCollectionId).toBeNull()
    expect(ctx.hasPage("overview")).toBe(false)
    // effectiveId falls back to the first published collection
    expect(ctx.collectionId).toBe("nba-top-shot")
  })
})

describe("normalizeBadgeKey", () => {
  it("strips diacritics, case, and non-alphanumerics", () => {
    expect(normalizeBadgeKey("Top Shot Debut")).toBe("topshotdebut")
    expect(normalizeBadgeKey("3-Star Rookie!")).toBe("3starrookie")
  })
})

describe("lookupBadge", () => {
  const map = { topshotdebut: { title: "Top Shot Debut" } } as any
  it("resolves via the normalized key, null on miss", () => {
    expect(lookupBadge(map, "Top Shot Debut")?.title).toBe("Top Shot Debut")
    expect(lookupBadge(map, "top shot debut")?.title).toBe("Top Shot Debut")
    expect(lookupBadge(map, "Unknown Badge")).toBeNull()
    expect(lookupBadge({}, "anything")).toBeNull()
  })
})

describe("classesForColorFamily", () => {
  it("maps a known family, neutral fallback for unknown/nullish", () => {
    expect(classesForColorFamily("gold")).toBe(COLOR_FAMILY_CLASSES.gold)
    expect(classesForColorFamily("nope")).toBe(COLOR_FAMILY_CLASSES.neutral)
    expect(classesForColorFamily(null)).toBe(COLOR_FAMILY_CLASSES.neutral)
    expect(classesForColorFamily(undefined)).toBe(COLOR_FAMILY_CLASSES.neutral)
  })
})
