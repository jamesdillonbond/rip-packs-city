import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// The concierge races every tool against a budget (TOOL_TIMEOUT_MS, default 6 s). Several
// tools answer by fetching a public insight board (fetchPublicInsight, its own 9 s abort).
// Until 2026-10-25 those tools ran under the 6 s default: a board answering in 6-9 s was
// discarded as a generic `status: "timeout"` and the fetch's own abort could never fire —
// and the deals tools' optional market-pulse note (9 s) could throw away a finished answer
// (it reddened main CI twice that morning). The property, read from the route source so it
// cannot drift: every tool's budget covers the fetches its branch makes, in sequence.

const SRC = readFileSync("app/api/support-chat/route.ts", "utf8")

function num(re: RegExp, what: string): number {
  const m = SRC.match(re)
  if (!m) throw new Error(`could not read ${what} from the route`)
  return Number(m[1])
}

const DEFAULT_FETCH_MS = num(/async function fetchPublicInsight\([\s\S]*?timeoutMs = (\d+)/, "fetchPublicInsight's default timeout")
const SHORT_MS = num(/const QUIET_MARKET_PULSE_TIMEOUT_MS = (\d+)/, "QUIET_MARKET_PULSE_TIMEOUT_MS")
const DEFAULT_BUDGET_MS = num(/TOOL_TIMEOUT_MS\[tb\.name\] \?\? (\d+)/, "the default tool budget")

function budgets(): Record<string, number> {
  const block = SRC.match(/const TOOL_TIMEOUT_MS: Record<string, number> = \{([\s\S]*?)\n\s*\};/)
  if (!block) throw new Error("TOOL_TIMEOUT_MS not found")
  const out: Record<string, number> = {}
  for (const m of block[1].matchAll(/^\s*([a-z_]+):\s*(\d+)/gm)) out[m[1]] = Number(m[2])
  return out
}

/** tool name -> summed timeouts of the fetchPublicInsight calls in its branch. */
function boardTools(): Record<string, number> {
  const out: Record<string, number> = {}
  const heads = [...SRC.matchAll(/if \(toolName === "([a-z_]+)"\) \{/g)]
  heads.forEach((h, i) => {
    const body = SRC.slice(h.index!, i + 1 < heads.length ? heads[i + 1].index! : SRC.length)
    let ms = 0
    for (const c of body.matchAll(/fetchPublicInsight\(([^;]*?)\)\)?;?\n/g)) {
      ms += /QUIET_MARKET_PULSE_TIMEOUT_MS/.test(c[1]) ? SHORT_MS : DEFAULT_FETCH_MS
    }
    if (ms > 0) out[h[1]] = (out[h[1]] ?? 0) + ms
  })
  return out
}

describe("every concierge tool's budget covers the board fetches it makes", () => {
  const tools = boardTools()
  const b = budgets()

  it("inspects a real population", () => {
    // 10-25: get_top_sales, get_market_movers, get_rookies, get_premiums, get_ecosystem_stat,
    // get_insight_board. A parser that stopped matching would pass the check vacuously.
    expect(Object.keys(tools).length).toBeGreaterThanOrEqual(6)
    expect(tools).toHaveProperty("get_top_sales")
    expect(tools.get_top_sales).toBe(DEFAULT_FETCH_MS + SHORT_MS)
  })

  it("no tool's fetches outlast its own budget", () => {
    const short = Object.entries(tools)
      .map(([t, ms]) => ({ tool: t, fetch_ms: ms, budget_ms: b[t] ?? DEFAULT_BUDGET_MS }))
      .filter((r) => r.budget_ms < r.fetch_ms)
    expect(short).toEqual([])
  })
})
