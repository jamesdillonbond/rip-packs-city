import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

// ── "Unknown" rendered as a Moment's subject (2026-09-29) ─────────────────────
// A 09-29 mobile sweep found a profile card reading "Unknown · Dynamic Duos · $8.00": a rendered
// `player_name ?? "Unknown"`. The word reads as a fact about the Moment when it is a fact about our
// join. lib/entity-href.ts `momentSubjectName(player, team, set)` names the team, then the set, then
// an honest dash. Six rendered sites carried the bare fallback; this pins them at zero.
//
// Scope: RENDERED files (.tsx) plus the row mapper that feeds the collection tables. API payload
// fields in .ts routes are a different contract and are not covered here.
// 2026-11-03: widened — the "Player" arm was case-sensitive, so `?? "Unknown player"` (giveaway pages,
// the Buyback dashboard) and `fullName ?? "Unknown player"` (Fast Break) slipped past it.
const PATTERN = /(player_?[nN]ame|playerName|fullName)\s*(\?\?|\|\|)\s*["'`]Unknown( [pP]layer)?["'`]/
// The same shape for a SET name, on rendered .tsx only (lib/collection/server-moment.ts' "Unknown Set" is a
// sentinel the wallet-search cache write strips by exact match — changing it there is a separate change).
const SET_PATTERN = /(set_?[nN]ame|setName)\s*(\?\?|\|\|)\s*["'`]Unknown( [sS]et)?["'`]/

function walk(dir: string, out: string[]) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (ent.name.endsWith(".tsx")) out.push(p)
  }
}

describe("no rendered Moment subject falls back to the word 'Unknown'", () => {
  it("the matcher catches the shapes it bans (not vacuous)", () => {
    expect(PATTERN.test(`{r.player_name ?? "Unknown"}`)).toBe(true)
    expect(PATTERN.test(`{listing.playerName ?? 'Unknown'}`)).toBe(true)
    expect(PATTERN.test(`{t.player_name || "Unknown Player"}`)).toBe(true)
    expect(PATTERN.test(`{momentSubjectName(r.player_name, null, r.set_name)}`)).toBe(false)
    expect(PATTERN.test(`{m.player_name ?? "Unknown player"}`)).toBe(true)
    expect(PATTERN.test(`{m.fullName ?? "Unknown player"}`)).toBe(true)
    expect(SET_PATTERN.test(`· {e.set_name ?? "Unknown set"}`)).toBe(true)
    expect(SET_PATTERN.test(`{e.set_name ? \`· \${e.set_name}\` : null}`)).toBe(false)
  })

  it("BAN AT ZERO across app/ and components/ .tsx, and the collection row mapper", () => {
    const files: string[] = []
    walk(path.join(process.cwd(), "app"), files)
    walk(path.join(process.cwd(), "components"), files)
    files.push(path.join(process.cwd(), "lib/collection/server-moment.ts"))
    expect(files.length).toBeGreaterThan(200)
    const hits: string[] = []
    for (const f of files) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return
        if (PATTERN.test(line) || (f.endsWith(".tsx") && SET_PATTERN.test(line))) hits.push(`${path.relative(process.cwd(), f)}:${i + 1}`)
      })
    }
    expect(hits, "use momentSubjectName(player, team, set) from lib/entity-href").toEqual([])
  })
})
