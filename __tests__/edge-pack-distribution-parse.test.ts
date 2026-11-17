import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  b64ToUtf8,
  resolveTargetKey,
  classifyDist,
  buildTopshotPackRow,
} from "@/supabase/functions/_shared/pack-distribution-parse"

// Pins the pack-distribution SEEDERS' filing core — the logic that decides which
// COLLECTION a distribution lands under and keeps its title/metadata from
// mojibake-corrupting on the way into `pack_distributions`. These edge fns had
// ZERO test reference before this file; the classifier had no behavioral pin at
// all, and a mis-classification silently mis-attributes a pack's EV/history.

const b64Utf8 = (s: string) => btoa(unescape(encodeURIComponent(s)))

describe("b64ToUtf8 — the mojibake guard (2026-07-25 corruption class)", () => {
  it("round-trips ASCII unchanged", () => {
    expect(b64ToUtf8(b64Utf8("Base Set 2024"))).toBe("Base Set 2024")
  })
  it("round-trips accented pack titles WITHOUT double-encoding", () => {
    for (const s of ["Atlético", "Jornada — Fútbol", "Peña", "Bayern München"]) {
      expect(b64ToUtf8(b64Utf8(s))).toBe(s)
    }
  })
  it("differs from a latin1 atob on multi-byte input (proves the fix matters)", () => {
    const encoded = b64Utf8("Atlético")
    expect(b64ToUtf8(encoded)).toBe("Atlético")
    expect(atob(encoded)).not.toBe("Atlético") // latin1 atob mojibakes it
  })
})

describe("resolveTargetKey — the ?collection= param resolver", () => {
  it("maps golazos and its laliga aliases to golazos", () => {
    for (const v of ["golazos", "Golazos", "  GOLAZOS  ", "laliga-golazos", "laliga_golazos"]) {
      expect(resolveTargetKey(v)).toBe("golazos")
    }
  })
  it("falls back to allday for anything else, incl. null/empty", () => {
    for (const v of [null, undefined, "", "allday", "nfl_all_day", "topshot", "garbage"]) {
      expect(resolveTargetKey(v)).toBe("allday")
    }
  })
})

describe("classifyDist — collection filing (a wrong bucket = wrong-collection pack)", () => {
  it("productID wins over title", () => {
    // productID says topshot even though the title mentions golazos
    expect(classifyDist({ meta_productID: "TopShot", title: "golazos jornada" })).toBe("topshot")
    expect(classifyDist({ meta_productID: "golazos", title: "NFL All Day" })).toBe("golazos")
  })
  it("classifies each product family by productID", () => {
    expect(classifyDist({ meta_productID: "golazos" })).toBe("golazos")
    expect(classifyDist({ meta_productID: "top_shot" })).toBe("topshot")
    expect(classifyDist({ meta_productID: "nfl_all_day" })).toBe("allday")
    expect(classifyDist({ meta_productId: "allday" })).toBe("allday") // lowercase productId key variant
  })
  it("falls back to title when productID is absent", () => {
    expect(classifyDist({ title: "LaLiga Golazos Jornada 5" })).toBe("golazos")
    expect(classifyDist({ title: "NBA Top Shot Series 4" })).toBe("topshot")
    expect(classifyDist({ title: "NFL All Day Base" })).toBe("allday")
  })
  it("jornada (Golazos-only word) routes to golazos", () => {
    expect(classifyDist({ title: "Jornada 12" })).toBe("golazos")
  })
  it("falls back to a broad any-value scan", () => {
    expect(classifyDist({ meta_url: "https://nbatopshot.com/x" })).toBe("topshot")
    expect(classifyDist({ meta_url: "https://nflallday.com/x" })).toBe("allday")
  })
  it("returns 'other' when nothing matches (so it is never mis-filed as a real collection)", () => {
    expect(classifyDist({ title: "Mystery Drop", meta_productID: "" })).toBe("other")
    expect(classifyDist({})).toBe("other")
  })
})

describe("buildTopshotPackRow — Studio node → catalog row", () => {
  it("maps title/image/metadata and parses slots as an integer", () => {
    const row = buildTopshotPackRow("42", "topshot-uuid", {
      distribution: {
        title: { value: "Base Set" },
        image_urls: { value: ["https://img/a.png", "https://img/b.png"] },
        uuid: { value: "u1" },
        tier: { value: "common" },
        pack_type: { value: "standard" },
        price: { value: 9 },
        number_of_pack_slots: { value: "3" },
        start_time: { value: "2026-01-01T00:00:00Z" },
      },
    })
    expect(row.collection_id).toBe("topshot-uuid")
    expect(row.dist_id).toBe("42")
    expect(row.title).toBe("Base Set")
    expect(row.image_url).toBe("https://img/a.png") // first url only
    expect(row.metadata.retail_price_usd).toBe(9)
    expect(row.metadata.number_of_pack_slots).toBe(3) // parseInt, not "3"
    // total_minted/total_opened must NOT be in the payload (durable columns)
    expect(row).not.toHaveProperty("total_minted")
    expect(row).not.toHaveProperty("total_opened")
  })
  it("null-safe: a distribution with no fields → all-null metadata, slots null (not NaN)", () => {
    const row = buildTopshotPackRow("7", "cid", { distribution: null })
    expect(row.title).toBeNull()
    expect(row.image_url).toBeNull()
    expect(row.metadata.number_of_pack_slots).toBeNull() // never NaN
    expect(row.metadata.retail_price_usd).toBeNull()
  })
})

describe("edge-fn source-drift guard — the two seeders carry the inline copies", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const alldaySrc = norm(
    readFileSync(
      path.join(root, "supabase/functions/seed-allday-pack-distributions/index.ts"),
      "utf8",
    ),
  )
  const topshotSrc = norm(
    readFileSync(
      path.join(root, "supabase/functions/seed-topshot-pack-distributions/index.ts"),
      "utf8",
    ),
  )
  const alldayImportsShared =
    /from\s+["'][^"']*_shared\/pack-distribution-parse/.test(alldaySrc)
  const topshotImportsShared =
    /from\s+["'][^"']*_shared\/pack-distribution-parse/.test(topshotSrc)

  const DECODE = norm('new TextDecoder("utf-8").decode(bytes)')
  const CLASSIFY_GOLAZOS = norm('productId === "golazos" || productId.includes("golazos")')
  const RESOLVE_TARGET = norm('v === "golazos" || v === "laliga-golazos" || v === "laliga_golazos"')
  const SLOTS_PARSE = norm("parseInt(d.number_of_pack_slots.value, 10)")

  it.each([
    ["utf-8 decode", DECODE],
    ["classifyDist golazos arm", CLASSIFY_GOLAZOS],
    ["resolveTarget alias set", RESOLVE_TARGET],
  ])("seed-allday imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(alldayImportsShared || alldaySrc.includes(expr)).toBe(true)
  })

  it("seed-topshot imports _shared, or carries the inline slots parseInt verbatim", () => {
    expect(topshotImportsShared || topshotSrc.includes(SLOTS_PARSE)).toBe(true)
  })
})
