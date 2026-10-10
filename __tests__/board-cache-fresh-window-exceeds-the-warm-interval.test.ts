import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BOARD_CACHE_FRESH_MS } from "@/lib/insights/board-cache"

// 2026-10-10: the board cache's "fresh" window must exceed the warm cron's interval,
// or every cached board reads as stale for part of each cycle and the next render
// runs the heavy live query the cache exists to avoid. On 08-30 the cron moved from
// every 5 to every 15 minutes in vercel.json alone, while the window stayed at
// 10 minutes. This derives the interval from vercel.json itself, so changing either
// side alone fails here.

function largestGapMinutes(schedule: string): number {
  const minuteField = schedule.trim().split(/\s+/)[0]
  const step = /^\*\/(\d+)$/.exec(minuteField)
  if (step) return Number(step[1])
  if (minuteField === "*") return 1
  const mins = minuteField.split(",").map((m) => Number(m)).sort((a, b) => a - b)
  if (mins.some((m) => !Number.isInteger(m) || m < 0 || m > 59)) {
    throw new Error(`unparsed minute field: ${minuteField}`)
  }
  if (mins.length === 1) return 60
  let gap = 60 - mins[mins.length - 1] + mins[0]
  for (let i = 1; i < mins.length; i++) gap = Math.max(gap, mins[i] - mins[i - 1])
  return gap
}

describe("board-cache fresh window vs the warm cron", () => {
  const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
    crons?: { path: string; schedule: string }[]
  }
  const warm = (vercel.crons ?? []).filter((c) => c.path === "/api/cron/refresh-insights-cache")

  it("vercel.json schedules the warm cron exactly once", () => {
    expect(warm).toHaveLength(1)
  })

  it("the fresh window exceeds the largest gap between warms", () => {
    const gapMs = largestGapMinutes(warm[0].schedule) * 60 * 1000
    expect(BOARD_CACHE_FRESH_MS).toBeGreaterThan(gapMs)
  })

  it("the gap parser reads the shapes this file uses (control)", () => {
    expect(largestGapMinutes("7,22,37,52 * * * *")).toBe(15)
    expect(largestGapMinutes("*/5 * * * *")).toBe(5)
    expect(largestGapMinutes("17 * * * *")).toBe(60)
    expect(largestGapMinutes("0,10,40 * * * *")).toBe(30)
  })
})
