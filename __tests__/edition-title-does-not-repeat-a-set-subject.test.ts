// __tests__/edition-title-does-not-repeat-a-set-subject.test.ts
//
// 2026-11-23: a no-player, no-team edition whose name IS its set name rendered the set twice:
// "NFL Draft — NFL Draft · Draft Pick · Apr 24, 2025 · /500" in its <title>, "NFL Draft NFL Draft ·
// Draft Pick … is worth ~$0.24" in its meta description, and the same in the JSON-LD Product name.
// 356 live pages (Candy 320, All Day 36). The fixtures are REAL production rows read that day.

import { describe, expect, it } from "vitest"
import { editionPageMetadata, editionJsonLd } from "@/lib/seo"
import { editionTitleContext, subjectWithContext } from "@/lib/edition-title-context"

const title = (p: Record<string, unknown>, c: string) => {
  const t = editionPageMetadata(p, c).title as unknown
  return typeof t === "string" ? t : String((t as { absolute?: string; default?: string }).absolute ?? (t as { default?: string }).default)
}
const description = (p: Record<string, unknown>, c: string) => String(editionPageMetadata(p, c).description ?? "")
const product = (p: Record<string, unknown>, c: string) =>
  (editionJsonLd(p, c) as { "@graph": Array<Record<string, unknown>> })["@graph"][0]

// All Day edition 4135: a redeemable draft-pick voucher (no player, no team on-chain; deep-audit R8).
const draftVoucher = {
  route_slug: "4135", external_id: "4135", name: "NFL Draft", set_name: "NFL Draft", player_name: null, team_name: null,
  play_type: "Draft Pick", play_category: null, game_date: "2025-04-24", circulation_count: 500, tier: "COMMON",
  description: "Use this Moment to earn the Rookie Debut from the selected draft pick.",
  fmv: { fmv_usd: 0.24 },
}
// Candy edition c:ghost-in-the-machine:ghost-in-the-machine: a non-player art edition.
const candyArt = {
  route_slug: "c:ghost-in-the-machine:ghost-in-the-machine", external_id: "c:ghost-in-the-machine:ghost-in-the-machine",
  name: "Ghost in the Machine", set_name: "Ghost in the Machine", player_name: null, team_name: null,
  circulation_count: 1809, tier: null, badges: null,
}
// Control: a player edition keeps its set in every surface.
const player = {
  route_slug: "4200", external_id: "4200", name: "Josh Allen", set_name: "Rookie Revelation", player_name: "Josh Allen",
  team_name: "Buffalo Bills", play_type: "Pass", game_date: "2025-09-07", circulation_count: 2500, tier: "RARE", fmv: { fmv_usd: 12 },
}

describe("an edition whose subject IS its set does not repeat the set", () => {
  it("All Day draft-pick voucher: title, description and JSON-LD carry 'NFL Draft' once before the play", () => {
    const t = title(draftVoucher, "nfl-all-day")
    expect(t).not.toMatch(/NFL Draft\W+NFL Draft/)
    expect(t.startsWith("NFL Draft — Draft Pick · Apr 24, 2025 · /500")).toBe(true)
    const d = description(draftVoucher, "nfl-all-day")
    expect(d).not.toMatch(/NFL Draft\W+NFL Draft/)
    expect(d).toContain("Use this Moment to earn the Rookie Debut from the selected draft pick.")
    const ld = product(draftVoucher, "nfl-all-day")
    expect(String(ld.name)).not.toMatch(/NFL Draft\W+NFL Draft/)
    expect(String(ld.description)).not.toMatch(/NFL Draft\W+NFL Draft/)
  })

  it("Candy art edition: an EMPTY context leaves the subject alone — no dangling ' — '", () => {
    expect(editionTitleContext(candyArt, "candy-mlb")).toBe("")
    const t = title(candyArt, "candy-mlb")
    expect(t).not.toMatch(/Ghost in the Machine\W+Ghost in the Machine/)
    expect(t).not.toMatch(/ — ·| —  ·/)
    expect(t.startsWith("Ghost in the Machine · ")).toBe(true)
    expect(String(product(candyArt, "candy-mlb").name)).toBe("Ghost in the Machine")
  })

  it("control: a player edition still names its set everywhere", () => {
    expect(title(player, "nfl-all-day")).toContain("Josh Allen — Rookie Revelation · Pass")
    expect(description(player, "nfl-all-day")).toContain("Josh Allen Rookie Revelation")
    expect(String(product(player, "nfl-all-day").name)).toContain("Josh Allen — Rookie Revelation")
  })

  it("subjectWithContext joins only a non-empty context", () => {
    expect(subjectWithContext("A", "")).toBe("A")
    expect(subjectWithContext("A", "B")).toBe("A — B")
    expect(subjectWithContext("A", "B", " ")).toBe("A B")
  })
})
