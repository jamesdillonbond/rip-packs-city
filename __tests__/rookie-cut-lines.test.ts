import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { buildRookieCutLines, type RankThresholdRow } from "@/lib/topshot/rookie-cut-lines"

// 2026-11-27. Top Shot's 2026-27 year-end rookie rewards go to leaderboards: a /3 Blue
// Chip for the top 3 holders of each All-Rookie player, a /26 Rookie Yearbook for the
// top 26 holders of every rookie. get_topshot_player_rank_thresholds already measures
// the #3 / #26 lines; the rookie player page now shows them.
//
// Pinned:
//   - a cut the board has not reached (NULL row: fewer collectors than the rank) is
//     OPEN, never $0 or 0 Moments;
//   - a board with zero collectors (the function's LEFT JOIN still returns four NULL
//     rows) shows nothing;
//   - numerics arrive as strings from PostgREST and are parsed;
//   - the page reads the thresholds only on the Top Shot branch, never for Candy.

const row = (cut: number, moments: string | null, usd: string | null, collectors: string): RankThresholdRow => ({
  rank_cutoff: cut,
  moments_held: moments,
  est_value_usd: usd,
  collectors,
})

describe("buildRookieCutLines", () => {
  it("reads the #3 and #26 lines from the function's rows", () => {
    const out = buildRookieCutLines([
      row(1, "28", "2728.00", "217"),
      row(3, "12", "1140.00", "217"),
      row(10, "6", "610.00", "217"),
      row(26, "3", "302.00", "217"),
    ])
    expect(out).toEqual({
      collectors: 217,
      lines: [
        { rank: 3, reward: "Blue Chip", open: false, moments: 12, valueUsd: 1140 },
        { rank: 26, reward: "Rookie Yearbook", open: false, moments: 3, valueUsd: 302 },
      ],
    })
  })

  it("a cut the board has not reached is OPEN — never $0 or 0 Moments", () => {
    const out = buildRookieCutLines([
      row(1, "4", "90.00", "12"),
      row(3, "2", "40.00", "12"),
      row(10, "1", "12.00", "12"),
      row(26, null, null, "12"),
    ])
    const yearbook = out?.lines.find((l) => l.rank === 26)
    expect(yearbook).toEqual({ rank: 26, reward: "Rookie Yearbook", open: true, moments: null, valueUsd: null })
  })

  it("a missing cut row is OPEN too", () => {
    const out = buildRookieCutLines([row(3, "2", "40.00", "12")])
    expect(out?.lines.find((l) => l.rank === 26)?.open).toBe(true)
  })

  it("a board with zero collectors shows nothing", () => {
    expect(buildRookieCutLines([row(1, null, null, "0"), row(3, null, null, "0"), row(26, null, null, "0")])).toBeNull()
  })

  it("no rows shows nothing", () => {
    expect(buildRookieCutLines([])).toBeNull()
  })
})

describe("rookie player page — cut lines strip", () => {
  const page = stripComments(readFileSync("app/(collections)/[collection]/player/[slug]/page.tsx", "utf8"))
  const lib = stripComments(readFileSync("lib/topshot/rookie-cut-lines.ts", "utf8"))

  it("reads the thresholds only in the Top Shot-only section (no other collection reads a name-keyed Top Shot board)", () => {
    // Since 2026-11-27 the strip has its own section (the walked-wallet Top Collectors panel it sat in is retired).
    expect(page.match(/fetchRookieCutLines\(/g)?.length).toBe(1)
    expect(page).toMatch(/async function RookieCutLinesSection\(\{ playerName \}: \{ playerName: string \}\) \{\s*const cutLines = await fetchRookieCutLines\(playerName\)/)
    expect(page).toContain('{collection === "nba-top-shot" && (\n        <Suspense fallback={null}>\n          <RookieCutLinesSection playerName={detail.name} />')
  })

  it("renders an open line as words, never a formatted zero", () => {
    expect(page).toMatch(/l\.open\s*\?\s*<>open — fewer than \{l\.rank\} collectors<\/>/)
    expect(page).not.toMatch(/fmtUsd\(l\.valueUsd \?\? 0\)/)
  })

  it("labels the lines a guide to Top Shot's own boards", () => {
    expect(page).toMatch(/Top Shot ranks its own boards by locked Top Shot Score/)
  })

  it("shows the strip only for the 2026 class, and nothing when a read failed", () => {
    expect(lib).toMatch(/from\("topshot_2026_rookie_players"\)/)
    expect(lib).toMatch(/if \(inClass !== true\) return null/)
    expect(lib).toMatch(/if \(!thresholds\.ok\) return null/)
  })
})
