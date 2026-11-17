// 2026-10-11 — the concierge's suggestion pills must ask for data, never for a
// buy / sell / invest call. The system prompt bans those calls and answers
// "should I buy?" with a refusal, so a pill shaped like one ("Best investment
// sets?", "Skip or buy?", "Is that pack worth ripping?", "Should I rip or buy
// singles?" — all four shipped) turned a first-time visitor's first tap into
// "I don't make buy/sell calls".
//
// Walks every string literal in the pill tables (PAGE_DEFAULTS through
// PUBLIC_PAGE_DEFAULTS), so a new table entry is covered without editing this.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = readFileSync(join(__dirname, "..", "components", "SupportChat.tsx"), "utf8")
const start = SRC.indexOf("const PAGE_DEFAULTS")
const end = SRC.indexOf("export default function SupportChat")
const region = SRC.slice(start, end).replace(/^\s*\/\/.*$/gm, "")
const pills = [...region.matchAll(/"([^"\n]{3,})"(?!\s*:)/g)].map((m) => m[1])

const ADVICE = /\b(invest(ment|ing)?|worth (buying|ripping|it)|should i|skip or buy|buy or (sell|skip|hold)|rip or buy|good buy|undervalued)\b/i

describe("concierge suggestion pills ask for data, not a buy/sell call", () => {
  it("inspects the pill tables (not vacuous)", () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(pills.length).toBeGreaterThan(80)
  })

  it("no pill asks for an investment, buy, sell or rip decision", () => {
    expect(pills.filter((p) => ADVICE.test(p))).toEqual([])
  })
})
