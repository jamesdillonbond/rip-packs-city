import { describe, it, expect } from "vitest"
import {
  BADGE_COLORS,
  badgeColor,
  tierKey,
  tierAccent,
  tierBorder,
  tierGlow,
  tierHoloClass,
  hiResThumb,
} from "@/lib/trophy/slab-style"

// Pins the trophy-slab style helpers (extracted from components/TrophySlab.tsx).
// These drive brand-critical, user-facing slab + PDF artwork; a wrong tier accent
// or a mis-rewritten Top Shot media URL ships a visibly broken trophy.

describe("badgeColor — slug normalization + fallback", () => {
  it("resolves a known badge by its snake_case key", () => {
    expect(badgeColor("jersey_match")).toBe(BADGE_COLORS.jersey_match)
    expect(badgeColor("championship_year")).toBe("#34D399")
  })
  it("normalizes a spaced/cased title to the underscore key", () => {
    expect(badgeColor("Rookie Mint")).toBe(BADGE_COLORS.rookie_mint)
    expect(badgeColor("Top Shot Debut")).toBe(BADGE_COLORS.top_shot_debut)
  })
  it("strips leading/trailing separators when normalizing", () => {
    expect(badgeColor("  perfect mint! ")).toBe(BADGE_COLORS.perfect_mint)
  })
  it("falls back to the neutral grey for an unknown badge", () => {
    expect(badgeColor("does-not-exist")).toBe("#94A3B8")
  })
  it("returns the neutral fallback for prototype-key slugs, not a prototype member", () => {
    // "toString"/"constructor"/etc. normalize to themselves and would resolve to
    // an Object.prototype function on a bare BADGE_COLORS[key] read.
    for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(badgeColor(key)).toBe("#94A3B8")
    }
  })
})

describe("tierKey — normalizes tier, nullish → common", () => {
  it("lowercases and defaults", () => {
    expect(tierKey("LEGENDARY")).toBe("legendary")
    expect(tierKey(null)).toBe("common")
  })
})

describe("tierAccent — one color per tier bucket", () => {
  it("maps each tier, with rare/challenger and common/contender sharing", () => {
    expect(tierAccent("legendary")).toBe("#B89000")
    expect(tierAccent("ultimate")).toBe("#D4521E")
    expect(tierAccent("rare")).toBe("#5654C7")
    expect(tierAccent("challenger")).toBe("#5654C7")
    expect(tierAccent("fandom")).toBe("#0F8E5E")
    expect(tierAccent("contender")).toBe("#5A6B7D")
  })
  it("nullish/unknown tiers fall back to the common grey", () => {
    expect(tierAccent(null)).toBe("#5A6B7D")
    expect(tierAccent("mystery")).toBe("#5A6B7D")
  })
})

describe("tierBorder — CSS var per tier, generic fallback", () => {
  it("maps each named tier to its border var", () => {
    expect(tierBorder("legendary")).toBe("var(--tier-legendary-border)")
    expect(tierBorder("ultimate")).toBe("var(--tier-ultimate-border)")
    expect(tierBorder("rare")).toBe("var(--tier-rare-border)")
    expect(tierBorder("fandom")).toBe("var(--tier-fandom-border)")
    expect(tierBorder("common")).toBe("var(--tier-common-border)")
    expect(tierBorder("challenger")).toBe("var(--tier-challenger-border)")
    expect(tierBorder("contender")).toBe("var(--tier-contender-border)")
  })
  it("unknown tier uses the generic rpc border; null coerces to common", () => {
    expect(tierBorder("mystery")).toBe("var(--rpc-border)")
    // tierKey(null) → "common", so null is a real tier bucket, not the default.
    expect(tierBorder(null)).toBe("var(--tier-common-border)")
  })
})

describe("tierGlow / tierHoloClass", () => {
  it("maps each tier bucket to its glow, sharing rare/challenger and common/contender", () => {
    expect(tierGlow("legendary")).toBe("rgba(255,215,0,0.10)")
    expect(tierGlow("ultimate")).toBe("rgba(255,107,53,0.10)")
    expect(tierGlow("rare")).toBe("rgba(129,140,248,0.08)")
    expect(tierGlow("fandom")).toBe("rgba(52,211,153,0.08)")
    expect(tierGlow("common")).toBe("rgba(148,163,184,0.05)")
    expect(tierGlow("rare")).toBe(tierGlow("challenger"))
    expect(tierGlow("common")).toBe(tierGlow("contender"))
    // unknown / null → the common/contender glow (default arm)
    expect(tierGlow("mystery")).toBe("rgba(148,163,184,0.05)")
    expect(tierGlow(null)).toBe("rgba(148,163,184,0.05)")
  })
  it("holo class only for the top three tiers, else empty", () => {
    expect(tierHoloClass("legendary")).toBe("rpc-holo-legendary")
    expect(tierHoloClass("ultimate")).toBe("rpc-holo-ultimate")
    expect(tierHoloClass("rare")).toBe("rpc-holo-rare")
    expect(tierHoloClass("fandom")).toBe("")
    expect(tierHoloClass(null)).toBe("")
  })
})

describe("hiResThumb — Top Shot media width rewrite", () => {
  it("returns undefined for a nullish url", () => {
    expect(hiResThumb(null)).toBeUndefined()
    expect(hiResThumb(undefined)).toBeUndefined()
  })
  it("bumps an existing width= on a Top Shot url to 640", () => {
    expect(hiResThumb("https://assets.nbatopshot.com/media/x?width=180")).toBe(
      "https://assets.nbatopshot.com/media/x?width=640",
    )
  })
  it("appends width=640 to a Top Shot url that has none (respecting ? vs &)", () => {
    expect(hiResThumb("https://assets.nbatopshot.com/media/x")).toBe(
      "https://assets.nbatopshot.com/media/x?width=640",
    )
    expect(hiResThumb("https://assets.nbatopshot.com/media/x?fit=crop")).toBe(
      "https://assets.nbatopshot.com/media/x?fit=crop&width=640",
    )
  })
  it("passes non-Top-Shot hosts through unchanged (AllDay / Pinnacle proxy)", () => {
    const url = "https://media.nflallday.com/x?width=512"
    expect(hiResThumb(url)).toBe(url)
  })
})
