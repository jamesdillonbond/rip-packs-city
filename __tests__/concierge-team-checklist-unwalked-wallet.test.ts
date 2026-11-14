import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-14 (fresh-eyes review of the concierge). /api/entity/team-checklist-full-editions sets
// `owned` from "a wallet was passed", not "that wallet was walked in this collection", so an unwalked
// wallet came back owned:false everywhere with progress.wallet_cached:false — and get_team_checklist
// told the user "0 owned", every edition "missing", and the full cost to finish.
const src = stripComments(readFileSync("app/api/support-chat/route.ts", "utf8"))
const tool = src.slice(src.indexOf('toolName === "get_team_checklist"'), src.indexOf('toolName === "get_team_checklist"') + 9000)

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
