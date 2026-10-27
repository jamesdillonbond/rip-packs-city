// __tests__/a-player-search-survives-a-missing-accent.test.ts
//
// #207, platform-wide (2026-10-22). A player / character search that reaches the
// database as `ilike '%typed%'` — `.ilike("player_name", …)`, `.ilike(
// "character_name", …)`, or an RPC's `p_player` — is accent-SENSITIVE: "doncic"
// answered 0 Sniper deals and "Dončić" 96 (live, 10-22), "acuna" nothing on the
// Candy board, "clasico" none of 23 "ElClásico" packs. 194 player names, 10
// Pinnacle characters and 163 pack titles carry a diacritic (measured 10-22).
//
// ── THE RULE ───────────────────────────────────────────────────────────────
// Every such search must sit within WINDOW lines of one of the paths that make
// it survive a missing accent — the resolver retry (lib/search/player-search-
// retry), the accent-blind regex retry (lib/search/accent-regex), the market /
// Sniper catalog resolver (lib/market/catalog-player), the table-arm fallback
// (lib/market/player-match), or the concierge's resolver scope — OR be listed in
// SANCTIONED with the reason it does not need one. Keyed PER OCCURRENCE, not per
// file: a file that hardened one search must not vouch for another.
//
// ⚠ Structurally SILENT about: a search built with a computed column name, a
// `.or(…ilike…)` string filter, and SQL inside a function body (the database
// side — rpc_search_catalog / resolve_player_name already use unaccent).

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const ROOTS = ["app", "lib"]
const WINDOW = 40
const SEARCH = /\.ilike\(\s*["'`](?:editions\.)?(?:player_name|character_name)["'`]|\bp_player\s*:(?!\s*null\b)/g
const COVER = /retryEmptyPlayerSearch|retryEmptyWithAccentRegex|resolveCatalogPlayer|withAccentFallback|resolvePlayerName|singleRetryLabel|playerScope/

/** path:line-of-match-text → why it needs no retry. Keyed on the matched line's text so a moved line still matches. */
const SANCTIONED: Record<string, string> = {
  "lib/concierge/allday-boards.ts|q = opts.playerId ? q.eq(\"player_id\", opts.playerId) : opts.playerLabels ? q.in(\"player_name\", opts.playerLabels) : q.ilike(\"player_name\", `%${opts.player}%`)": "the concierge resolves the PERSON up front (executeTool → resolvePlayerForDistribution → playerScope.playerId / labels, passed in as opts); the ilike runs only when that resolution found nothing, exactly as the Top Shot get_badge_info arm",
  "app/api/badges/route.ts|countQ = countQ.ilike(\"player_name\", player)": "exact-match API param (no wildcard), filled by callers from catalog names; no search box sends it",
  "app/api/badges/route.ts|dataQ  = dataQ.ilike(\"player_name\", player)": "same read as the count above",
  "app/api/collection-moments/route.ts|p_player: playerFilter || null,": "the wallet Player filter is a dropdown of the wallet's own exact names",
  "app/api/market/route.ts|if (player) q = q.ilike(\"player_name\", `%${player}%`)": "legacy cached_listings fallback; `player` is already the #207-resolved spelling (reassigned above)",
  "app/api/sniper-feed/route.ts|if (scope.player) out = out.ilike(\"player_name\", ilikeContains(scope.player));": "the handler's runFeed retry (resolveCatalogPlayer in GET) re-runs this whole build",
  "app/api/sniper-feed/route.ts|...((opts.player ?? \"\").trim() ? { p_player: (opts.player ?? \"\").trim() } : {}),": "the handler's runFeed retry re-runs this whole build",
  "app/api/sniper-feed/route.ts|...(player ? { p_player: player } : {}),": "the handler's runFeed retry re-runs this whole build",
  "lib/concierge/catalog-deals-index.ts|p_player: who,": "callers pass the resolver's labels; the typed text is used only when it named no single person",
  "lib/concierge/fmv-distribution.ts|else if (input.player) out = out.ilike(\"player_name\", `%${input.player}%`)": "player_id (resolver) first; this ilike is the fallback when no single person was named",
  "lib/concierge/fmv-distribution.ts|p_player: input.playerId ? null : (input.player ?? null),": "the same fallback as the slice's ilike above, sent only after that ilike already matched 500+ editions (so the spelling is not the empty-result case #207 guards)",
  "lib/special-serial-owners-board.ts|p_player: opts.player ?? null,": "its route resolves (singleRetryLabel) and re-calls with the spelling",
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

function findings(files: string[]) {
  const uncovered: string[] = []
  const sanctionedHit = new Set<string>()
  let inspected = 0
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"))
    const lines = src.split("\n")
    for (const m of src.matchAll(SEARCH)) {
      inspected++
      const ln = src.slice(0, m.index).split("\n").length
      const key = `${f}|${lines[ln - 1].trim()}`
      if (COVER.test(lines.slice(Math.max(0, ln - 1 - WINDOW), ln + WINDOW).join("\n"))) continue
      if (SANCTIONED[key]) { sanctionedHit.add(key); continue }
      uncovered.push(`${f}:${ln}: ${lines[ln - 1].trim()}`)
    }
  }
  return { uncovered, sanctionedHit, inspected }
}

describe("a player search survives a missing accent", () => {
  const files = ROOTS.flatMap((r) => walk(r))
  const { uncovered, sanctionedHit, inspected } = findings(files)

  it("walks the tree and inspects the searches (a guard that inspected nothing has not passed)", () => {
    expect(files.length).toBeGreaterThan(500)
    expect(inspected).toBeGreaterThan(20)
  })

  it("every player/character search is covered by a retry or resolver, or sanctioned with a reason", () => {
    expect(uncovered).toEqual([])
  })

  it("no sanctioned entry is stale (its line still exists and still needs the exception)", () => {
    for (const key of Object.keys(SANCTIONED)) {
      expect(existsSync(key.split("|")[0]), key).toBe(true)
      expect(sanctionedHit.has(key), `stale SANCTIONED entry: ${key}`).toBe(true)
    }
  })

  it("the detector is live (planted positives and negatives)", () => {
    const has = (s: string) => new RegExp(SEARCH.source).test(s)
    expect(has(`q = q.ilike("player_name", \`%\${p}%\`)`)).toBe(true)
    expect(has(`q.ilike('character_name', x)`)).toBe(true)
    expect(has(`q.ilike("editions.player_name", x)`)).toBe(true)
    expect(has(`{ p_player: player }`)).toBe(true)
    expect(has(`{ p_player: null }`)).toBe(false)
    expect(has(`q.ilike("set_name", x)`)).toBe(false)
    expect(COVER.test("await retryEmptyPlayerSearch({")).toBe(true)
  })
})
