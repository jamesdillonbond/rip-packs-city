// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import { normalizeBadges } from "@/components/BadgeRow"

// normalizeBadges merges 4 badge sources into one deduped list. A dedup/source
// regression sprouts duplicate or mis-tagged badges on every moment.

describe("normalizeBadges", () => {
  it("merges all four sources with the right source tags", () => {
    const out = normalizeBadges({
      badges: [{ title: "Rookie", source: "derived" }],
      badge_titles: ["Championship"],
      play_tags: [{ title: "Dunk" }],
      set_play_tags: [{ title: "Reel" }],
    })
    expect(out.map((b) => [b.title, b.source])).toEqual([
      ["Rookie", "derived"],
      ["Championship", "derived"],
      ["Dunk", "play_tag"],
      ["Reel", "set_play_tag"],
    ])
  })

  it("dedups case-insensitively across sources (first occurrence wins)", () => {
    const out = normalizeBadges({
      badges: [{ title: "Rookie" }],
      badge_titles: ["rookie", "ROOKIE"],
      play_tags: [{ title: "Rookie" }],
    })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe("Rookie")
    expect(out[0].source).toBe("derived") // came from `badges` first
  })

  it("skips empty/whitespace titles and null sources", () => {
    const out = normalizeBadges({
      badges: [{ title: "" }, { title: "Real" }],
      play_tags: null,
      set_play_tags: undefined as never,
    })
    expect(out.map((b) => b.title)).toEqual(["Real"])
  })

  it("defaults badge id + source when absent", () => {
    const [b] = normalizeBadges({ badges: [{ title: "X" }] })
    expect(b.id).toBe("b-X")
    expect(b.source).toBe("derived")
  })

  it("empty input → []", () => {
    expect(normalizeBadges({})).toEqual([])
  })
})
