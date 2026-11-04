// #228 (2026-11-04): /api/collection-snapshot waits up to SNAPSHOT_READ_BUDGET_MS for a cache-cold
// whale read. A caller that aborts sooner turns that slow success back into an error — the concierge's
// get_collection_snapshot did (10 s abort vs a 20 s route budget). Read both numbers from source.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const route = readFileSync("app/api/collection-snapshot/route.ts", "utf8")
const chat = readFileSync("app/api/support-chat/route.ts", "utf8")
const ms = (s: string) => Number(s.replace(/_/g, ""))

describe("the concierge snapshot tool waits at least as long as the snapshot route", () => {
  const routeBudget = ms(route.match(/const SNAPSHOT_READ_BUDGET_MS = ([0-9_]+)/)?.[1] ?? "NaN")
  const head = chat.indexOf('if (toolName === "get_collection_snapshot") {')
  const branch = chat.slice(head, chat.indexOf('if (toolName === "', head + 10))
  const abort = ms(branch.match(/collection-snapshot\?wallet=[\s\S]*?AbortSignal\.timeout\(([0-9_]+)\)/)?.[1] ?? "NaN")
  const budget = ms(chat.match(/get_collection_snapshot: ([0-9_]+)/)?.[1] ?? "NaN")

  it("reads all three numbers", () => {
    expect(head).toBeGreaterThan(-1)
    expect(routeBudget).toBeGreaterThan(0)
    expect(abort).toBeGreaterThan(0)
    expect(budget).toBeGreaterThan(0)
  })
  it("the fetch abort outlasts the route's read budget, and the tool budget outlasts the abort", () => {
    expect(abort).toBeGreaterThan(routeBudget)
    expect(budget).toBeGreaterThan(abort)
  })
})
