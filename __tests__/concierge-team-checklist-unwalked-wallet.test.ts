import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-14 (fresh-eyes review of the concierge). /api/entity/team-checklist-full-editions sets
// `owned` from "a wallet was passed", not "that wallet was walked in this collection", so an unwalked
// wallet came back owned:false everywhere with progress.wallet_cached:false — and get_team_checklist
// told the user "0 owned", every edition "missing", and the full cost to finish.
const src = stripComments(readFileSync("app/api/support-chat/route.ts", "utf8"))
// The whole branch, up to the next tool (a fixed window fell short as the branch grew, 2026-11-23).
const toolStart = src.indexOf('toolName === "get_team_checklist"')
const tool = src.slice(toolStart, src.indexOf('toolName === "get_team_intel"', toolStart))

describe("concierge get_team_checklist — an unwalked wallet's ownership is unknown", () => {
  it("reads progress.wallet_cached", () => {
    expect(tool).toMatch(/const walletUnwalked = wallet != null && progress\?\.wallet_cached === false/)
  })
  it("never hands the model a 'missing' list or progress for an unwalked wallet", () => {
    expect(tool).toMatch(/walletUnwalked \? \{ most_valuable_in_catalog: missing \} : \{ most_valuable_missing: missing \}/)
    expect(tool).toMatch(/progress: walletUnwalked \? null : progress/)
    expect(tool).toMatch(/UNKNOWN — not zero/)
  })
})

// 2026-11-23: the tool also reads the Series Checklists panel. The same unknown-not-zero rule holds there, a failed
// read is "unavailable" (never a team with no series), and an unlisted player is never folded into the cost.
describe("concierge get_team_checklist — series_checklists", () => {
  it("an unwalked wallet gets no owned / to-go / cost / missing players", () => {
    expect(tool).toMatch(/wallet && !walletUnwalked \? \{ players_owned: s\.players_owned, to_go: s\.to_go, complete: s\.complete \} : \{\}/)
    expect(tool).toMatch(/cost_to_go_usd: walletUnwalked \? null : s\.cost_to_go_usd/)
    expect(tool).toMatch(/missing_players: walletUnwalked \? undefined :/)
    expect(tool).toMatch(/closest_series_num: walletUnwalked \? null :/)
  })
  it("a failed series read is 'unavailable', and the how_to_read forbids pricing unlisted players", () => {
    expect(tool).toMatch(/seriesData == null\s*\? \{ status: "unavailable"/)
    expect(tool).toMatch(/never a bare total, never \$0 for them/)
  })
})
