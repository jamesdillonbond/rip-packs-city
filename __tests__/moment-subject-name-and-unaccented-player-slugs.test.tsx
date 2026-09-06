// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { momentSubjectHref, momentSubjectName } from "@/lib/entity-href"
import { slugifyName, slugifyPlayerName } from "@/lib/entity-labels"
import PackThumb, { isRenderablePackArtSrc } from "@/components/packs/PackThumb"

// ── 2026-09-06 entity QA sweep (510 pages, served HTML + real 390px Chromium) ──
// Three defects, each pinned here by the ABSENCE of the false claim:
//   1. "Unknown" rendered as the subject of a team Moment on a pack page
//      ("Unknown · Squad Goals · $3.74"). 151 canonical Top Shot editions have a
//      NULL player_name and 151/151 have a team_name.
//   2. 4 sitemap player URLs 404'd because the slug kept the diacritics'
//      residue ("Vít Krejčí" → "v-t-krej-"). Player slugs are now NFD-stripped;
//      set/team slugs are NOT (their resolvers do not unaccent).
//   3. Pack art that died BEFORE hydration (CSP-blocked / 404 host) kept its
//      broken-image glyph because React attached onError after the error had
//      already fired; and five distributions carry an .mp4 as image_url.

afterEach(cleanup)

describe("momentSubjectName — never the word Unknown", () => {
  it("prefers the player, then the team, then the set, then an honest dash", () => {
    expect(momentSubjectName("LaMelo Ball", "Charlotte Hornets", "Base Set")).toBe("LaMelo Ball")
    expect(momentSubjectName(null, "Charlotte Hornets", "Squad Goals")).toBe("Charlotte Hornets")
    expect(momentSubjectName("  ", "Charlotte Hornets", "Squad Goals")).toBe("Charlotte Hornets")
    expect(momentSubjectName(null, null, "Squad Goals")).toBe("Squad Goals")
    expect(momentSubjectName(null, null, null)).toBe("—")
    expect(momentSubjectName(undefined, undefined)).toBe("—")
  })

  it("never returns Unknown for any input", () => {
    for (const p of [null, undefined, "", " "]) for (const t of [null, undefined, "", " "]) {
      expect(momentSubjectName(p, t, null)).not.toMatch(/unknown/i)
    }
  })
})

describe("slugifyPlayerName — diacritics stripped for PLAYER slugs only", () => {
  it("strips combining marks so both spellings land on one slug", () => {
    expect(slugifyPlayerName("Vít Krejčí")).toBe("vit-krejci")
    expect(slugifyPlayerName("Dražen Petrović")).toBe("drazen-petrovic")
    expect(slugifyPlayerName("Noémie Brochant")).toBe("noemie-brochant")
    expect(slugifyPlayerName("Frieda Bühner")).toBe("frieda-buhner")
    expect(slugifyPlayerName("Vit Krejci")).toBe(slugifyPlayerName("Vít Krejčí"))
  })

  it("is byte-identical to slugifyName for plain ASCII (the common case does not move)", () => {
    for (const n of ["LeBron James", " Domantas Sabonis ", "Shai Gilgeous-Alexander", "Jaren Jackson Jr."]) {
      expect(slugifyPlayerName(n)).toBe(slugifyName(n))
    }
  })

  it("slugifyName itself is unchanged — set/team resolvers do not unaccent", () => {
    // Pinned so a future "helpful" NFD strip in slugifyName is caught: an
    // accented set/team name that resolves today would stop resolving.
    expect(slugifyName("Vít Krejčí")).toBe("v-t-krej-")
  })

  it("momentSubjectHref sends an accented player to the unaccented player URL, a team Moment to the team URL", () => {
    expect(momentSubjectHref("nba-top-shot", "Vít Krejčí", "Atlanta Hawks")).toBe("/nba-top-shot/player/vit-krejci")
    expect(momentSubjectHref("nba-top-shot", "Dallas Wings", "Dallas Wings")).toBe("/nba-top-shot/team/dallas-wings")
  })
})

describe("PackThumb — dead art never leaves a broken-image glyph", () => {
  it("treats an .mp4 image_url as no art at all", () => {
    expect(isRenderablePackArtSrc("https://assets.nflallday.com/tmp/HoloIcon3_Pack_Reward.mp4")).toBe(false)
    expect(isRenderablePackArtSrc("https://assets.nflallday.com/tmp/x.mp4?v=2")).toBe(false)
    expect(isRenderablePackArtSrc("https://assets.nflallday.com/tmp/pack.png")).toBe(true)
    expect(isRenderablePackArtSrc(null)).toBe(false)
    const { container } = render(<PackThumb src="https://assets.nflallday.com/tmp/HoloIcon3_Pack_Reward.mp4" alt="Reward Pack" />)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("Pack")
  })

  it("catches an error that fired BEFORE hydration (complete && naturalWidth === 0 on mount)", () => {
    // jsdom never loads images, so `complete` is what we pin here: define the
    // browser's post-failure verdict on the prototype for this test only.
    const proto = HTMLImageElement.prototype
    const complete = Object.getOwnPropertyDescriptor(proto, "complete")
    const natural = Object.getOwnPropertyDescriptor(proto, "naturalWidth")
    Object.defineProperty(proto, "complete", { configurable: true, get: () => true })
    Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => 0 })
    try {
      const { container } = render(<PackThumb src="https://storage.cloud.google.com/dead/pack.png" alt="Dead Pack" />)
      expect(container.querySelector("img")).toBeNull()
      expect(container.textContent).toContain("Pack")
    } finally {
      if (complete) Object.defineProperty(proto, "complete", complete)
      if (natural) Object.defineProperty(proto, "naturalWidth", natural)
    }
  })

  it("control: a still-loading image (complete === false) is NOT treated as dead", () => {
    const proto = HTMLImageElement.prototype
    const complete = Object.getOwnPropertyDescriptor(proto, "complete")
    const natural = Object.getOwnPropertyDescriptor(proto, "naturalWidth")
    Object.defineProperty(proto, "complete", { configurable: true, get: () => false })
    Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => 0 })
    try {
      const { container } = render(<PackThumb src="https://assets.nflallday.com/tmp/pack.png" alt="Live Pack" />)
      expect(container.querySelector("img")).not.toBeNull()
    } finally {
      if (complete) Object.defineProperty(proto, "complete", complete)
      if (natural) Object.defineProperty(proto, "naturalWidth", natural)
    }
  })
})
