import { describe, it, expect } from "vitest"
import {
  fmtMoney,
  fmtInt,
  truncAddr,
  tierColor,
  tagLabel,
  serialLabel,
  editionHref,
  momentImg,
} from "@/lib/special-serial-owners-format"

describe("special-serial-owners-format — fmtMoney / fmtInt / truncAddr", () => {
  it("fmtMoney: em-dash for null, whole $ at/above $100, 2 decimals below", () => {
    expect(fmtMoney(null)).toBe("—")
    expect(fmtMoney(250.6)).toBe("$251")
    expect(fmtMoney(12.5)).toBe("$12.50")
  })
  it("fmtInt groups, em-dash for null", () => {
    expect(fmtInt(12345)).toBe("12,345")
    expect(fmtInt(null)).toBe("—")
  })
  it("truncAddr em-dash for null (this page's variant), ellipsizes long", () => {
    expect(truncAddr(null)).toBe("—")
    expect(truncAddr("0x1234567890abcdef")).toBe("0x1234…cdef")
    expect(truncAddr("0xshort")).toBe("0xshort")
  })
})

describe("special-serial-owners-format — tierColor", () => {
  it("maps known tiers (case-insensitive), Uncommon reuses the rare hue, unknown→muted", () => {
    expect(tierColor("legendary")).toBe("var(--tier-legendary)")
    expect(tierColor("ULTIMATE")).toBe("var(--tier-ultimate)")
    expect(tierColor("UNCOMMON")).toBe("var(--tier-rare)")
    expect(tierColor("COMMON")).toBe("var(--tier-common)")
    expect(tierColor(null)).toBe("var(--rpc-text-muted)")
    expect(tierColor("mythic")).toBe("var(--rpc-text-muted)")
  })
})

describe("special-serial-owners-format — tagLabel", () => {
  it("maps #1/perfect/jersey, uppercases the rest", () => {
    expect(tagLabel("#1")).toBe("#1 MINT")
    expect(tagLabel("perfect")).toBe("PERFECT")
    expect(tagLabel("jersey")).toBe("JERSEY")
    expect(tagLabel("other")).toBe("OTHER")
    expect(tagLabel(null)).toBe("")
  })
})

describe("special-serial-owners-format — serialLabel", () => {
  it("includes circulation when known", () => {
    expect(serialLabel({ serial: 7, circulation_count: 100 })).toBe("#7 / 100")
  })
  it("omits circulation when null", () => {
    expect(serialLabel({ serial: 7, circulation_count: null })).toBe("#7")
  })
})

describe("special-serial-owners-format — editionHref / momentImg", () => {
  it("editionHref builds a per-collection edition link, null without an edition_key", () => {
    expect(editionHref({ serial: 1, edition_key: "ts:1" }, "nba-top-shot")).toBe("/nba-top-shot/edition/ts%3A1")
    expect(editionHref({ serial: 1, edition_key: null }, "nba-top-shot")).toBeNull()
  })
  it("momentImg uses AllDay edition-keyed art for nfl-all-day", () => {
    expect(momentImg({ serial: 1, edition_key: "42" }, "nfl-all-day")).toContain("media.nflallday.com/editions/42/media/image")
    expect(momentImg({ serial: 1, edition_key: null }, "nfl-all-day")).toBeNull()
  })
  it("momentImg uses TopShot nft-keyed art otherwise", () => {
    expect(momentImg({ serial: 1, nft_id: "abc" }, "nba-top-shot")).toContain("assets.nbatopshot.com/media/abc/image")
    expect(momentImg({ serial: 1, nft_id: null }, "nba-top-shot")).toBeNull()
  })
})
