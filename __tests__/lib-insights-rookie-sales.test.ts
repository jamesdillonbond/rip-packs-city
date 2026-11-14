import { describe, it, expect } from "vitest"
import { buildRookieSalesBoard, isStandardRookieDebut } from "@/lib/insights/rookie-sales"
import { draftPick2026, DRAFT_2026_PICK_COUNT } from "@/lib/insights/draft-2026"

// The 2026 rookie since-release board (Trevor's Wednesday post, 11-14). Pins the promises the
// post makes: every edition counts, the image is a STANDARD Rookie Debut moment (never a
// parallel), the season line skips DNPs and refuses an ambiguous ESPN name, and the pick is
// null for a player the 2026 draft never took.

const ed = (id: string, player_name: string, external_id: string, set_name = "Rookie Debut", team_name = "Team A") => ({
  id, player_name, external_id, set_name, team_name,
})
const sale = (id: string, edition_id: string, price_usd: number, nft_id: string, sold_at: string) => ({
  id, edition_id, price_usd, nft_id, sold_at,
})
const game = (espn_id: string, event_id: string, pts: number, opts: { dnp?: boolean; season?: number; type?: number; date?: string } = {}) => ({
  espn_id, event_id, game_date: opts.date ?? `2026-11-${event_id.padStart(2, "0")}`, season: opts.season ?? 2027,
  season_type: opts.type ?? 2, did_not_play: opts.dnp ?? false,
  stats: { points: String(pts), rebounds: "5", assists: "2" },
})

describe("buildRookieSalesBoard", () => {
  const base = {
    cohort: ["Alpha One", "Beta Two"],
    editions: [
      ed("e1", "Alpha One", "281:1"),
      ed("e1p", "Alpha One", "281:1::18"),          // a parallel of the same play
      ed("e1u", "Alpha One", "285:9", "Rookie Ultimate"),
      ed("e2", "Beta Two", "281:2", "Rookie Debut", "Team B"),
      ed("x", "Not A Rookie", "1:1"),
    ],
    sales: [
      sale("s1", "e1", 100, "n-std-old", "2026-11-01T00:00:00Z"),
      sale("s2", "e1p", 300, "n-par-new", "2026-11-05T00:00:00Z"),
      sale("s3", "e1u", 2000, "n-ult", "2026-11-06T00:00:00Z"),
      sale("s4", "e2", 50, "n-b", "2026-11-02T00:00:00Z"),
      sale("s5", "e2", 0, "n-zero", "2026-11-03T00:00:00Z"),
      sale("s6", "x", 9999, "n-x", "2026-11-04T00:00:00Z"),
    ],
    athletes: [
      { espn_id: "a1", display_name: "Alpha One" },
      { espn_id: "b1", display_name: "Beta Two" },
      { espn_id: "b2", display_name: "Beta Two" },     // ambiguous name
    ],
    games: [
      game("a1", "1", 10), game("a1", "2", 20), game("a1", "3", 99, { dnp: true }),
      game("a1", "4", 50, { season: 2026 }),           // last season — not this season's line
      game("a1", "5", 70, { type: 3 }),                // playoffs — not the regular season
      game("b1", "1", 30),
    ],
  }

  it("sums every edition (parallels and Ultimates included) and ignores $0 sales and non-cohort editions", () => {
    const b = buildRookieSalesBoard(base)
    const a = b.rows.find((r) => r.player_name === "Alpha One")!
    expect(a.sales).toBe(3)
    expect(a.gmv_usd).toBe(2400)
    const be = b.rows.find((r) => r.player_name === "Beta Two")!
    expect(be.sales).toBe(1)
    expect(b.totals).toEqual({ players: 2, sales: 4, gmv_usd: 2450 })
    expect(b.rows.map((r) => r.rank)).toEqual([1, 2])
    expect(b.rows[0].player_name).toBe("Alpha One")
  })

  it("never picks a parallel or Ultimate moment for the image, even when it sold more recently", () => {
    const a = buildRookieSalesBoard(base).rows.find((r) => r.player_name === "Alpha One")!
    expect(a.image_nft_id).toBe("n-std-old")
  })

  it("averages only games played in the newest regular season", () => {
    const a = buildRookieSalesBoard(base).rows.find((r) => r.player_name === "Alpha One")!
    expect(a.season).toEqual({ games: 2, ppg: 15, rpg: 5, apg: 2, through: "2026-11-02" })
  })

  it("gives no season line to a name with more than one ESPN athlete — never one of them", () => {
    const be = buildRookieSalesBoard(base).rows.find((r) => r.player_name === "Beta Two")!
    expect(be.season).toBeNull()
  })

  it("keeps a cohort rookie with no sales on the board at zero, ranked last", () => {
    const b = buildRookieSalesBoard({ ...base, cohort: [...base.cohort, "Gamma Three"] })
    expect(b.rows.at(-1)).toMatchObject({ player_name: "Gamma Three", sales: 0, gmv_usd: 0, image_nft_id: null })
  })
})

describe("isStandardRookieDebut", () => {
  it("is the base Rookie Debut edition only", () => {
    expect(isStandardRookieDebut({ external_id: "281:9324", set_name: "Rookie Debut" })).toBe(true)
    expect(isStandardRookieDebut({ external_id: "281:9324::17", set_name: "Rookie Debut" })).toBe(false)
    expect(isStandardRookieDebut({ external_id: "285:9443", set_name: "Rookie Ultimate" })).toBe(false)
  })
})

describe("draftPick2026", () => {
  it("knows the 60 picks, matching names across accents and case", () => {
    expect(DRAFT_2026_PICK_COUNT).toBe(60)
    expect(draftPick2026("AJ Dybantsa")).toBe(1)
    expect(draftPick2026("Meleek Thomas")).toBe(34)
    expect(draftPick2026("Karim Lopez")).toBe(21)
    expect(draftPick2026("karim lópez")).toBe(21)
  })

  it("is null — not a guess — for a rookie the 2026 draft did not take", () => {
    expect(draftPick2026("Bogoljub Markovic")).toBeNull()
    expect(draftPick2026("Graham Ike")).toBeNull()
  })
})
