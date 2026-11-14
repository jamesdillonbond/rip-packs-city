import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-14 (fresh-eyes review of the personal surfaces). get_team_checklist_progress answers
// owned 0 / completion_pct 0 with wallet_cached:false when the wallet has never been walked in that
// collection. TeamChecklist gates on it; the /my-teams card printed "0% · 0 / N owned · Cost to
// finish $X" — a measured zero nobody measured. Async server page, so pinned structurally.
const src = stripComments(readFileSync("app/my-teams/page.tsx", "utf8"))

describe("/my-teams — an unwalked wallet's progress is unknown, not 0%", () => {
  it("completion and cost are withheld when wallet_cached is false", () => {
    expect(src).toMatch(/const walletUnwalked = progress\?\.wallet_cached === false/)
    expect(src).toMatch(/const pct = walletUnwalked \? null :/)
    expect(src).toMatch(/const cost = walletUnwalked \? null :/)
  })
})
