import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import {
  isAllDaySlug,
  allDayNotApplicable,
  readAllDayHotFloorsForConcierge,
  readAllDayBadgesForConcierge,
  readAllDaySetCompletionForConcierge,
  isFlowAddress,
} from "@/lib/concierge/allday-boards"

/**
 * The concierge's All Day arms (All Day ↔ Top Shot parity, 2026-10-26). Each closes a SUBSTITUTION — an All Day
 * question answered with Top Shot rows — or a false claim ("badges are Top Shot only"). Asserted: the absence of
 * the false claim, three states on every read, and that each All Day arm returns BEFORE the Top Shot read.
 */

const BASE = "https://www.rippackscity.com"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpcDb = (res: any, calls: any[] = []) => ({ rpc: (n: string, a?: unknown) => { calls.push([n, a]); return Promise.resolve(res) } })

describe("isAllDaySlug / isFlowAddress", () => {
  it("accepts both spellings and nothing else", () => {
    expect(isAllDaySlug("nfl-all-day")).toBe(true)
    expect(isAllDaySlug("nfl_all_day")).toBe(true)
    expect(isAllDaySlug("NFL-All-Day")).toBe(true)
    expect(isAllDaySlug("nba-top-shot")).toBe(false)
    expect(isAllDaySlug(undefined)).toBe(false)
  })
  it("a Flow address is 0x + 16 hex", () => {
    expect(isFlowAddress("0xb7700366fa738a43")).toBe(true)
    expect(isFlowAddress("NicelyDone")).toBe(false)
  })
  it("not_applicable forbids Top Shot data", () => {
    const j = JSON.parse(allDayNotApplicable("t", "why."))
    expect(j.status).toBe("not_applicable")
    expect(j.message).toMatch(/Do not answer with Top Shot data/)
  })
})

describe("readAllDayHotFloorsForConcierge", () => {
  it("reads the All Day board, never names a collector and never says Quick Buy happened", async () => {
    const calls: unknown[] = []
    const out = JSON.parse(await readAllDayHotFloorsForConcierge(rpcDb({ data: { editions: [{ external_id: "3201", player_name: "Anthony Richardson", sweep_buyers: 2, swept_sales: 22, swept_spend: 2.7, floor_ask: 0.18, floor_ask_verified_at: "2026-10-26T23:15:01Z", fmv_usd: 0.1 }] }, error: null }, calls), BASE, { days: 7, limit: 15 }))
    expect(calls).toEqual([["get_allday_hot_floors", { p_days: 7 }]])
    expect(out.status).toBe("ok")
    expect(out.hot_floors[0].avg_paid_usd).toBe(0.12)
    expect(out.hot_floors[0].edition_url).toBe(`${BASE}/nfl-all-day/edition/3201`)
    expect(JSON.stringify(out.hot_floors)).not.toMatch(/0x[0-9a-f]{16}/)
    expect(out.note).toMatch(/not Top Shot's Quick-Buy/)
  })
  it("an error or a non-array is an error, never an empty board", async () => {
    expect(JSON.parse(await readAllDayHotFloorsForConcierge(rpcDb({ data: null, error: { message: "x" } }), BASE, { days: 7, limit: 5 })).status).toBe("error")
    expect(JSON.parse(await readAllDayHotFloorsForConcierge(rpcDb({ data: {}, error: null }), BASE, { days: 7, limit: 5 })).status).toBe("error")
  })
})

describe("readAllDayBadgesForConcierge", () => {
  const census = { data: { editions_indexed: 5607, badges: [{ id: "rookie-year", title: "Rookie Year", editions: 1158, by_tier: { RARE: 365 } }, { id: "all-day-debut", title: "ALL DAY Debut", editions: 1367, by_tier: {} }] }, error: null }
  it("lists All Day's badges with live counts and never claims badges are Top Shot only", async () => {
    const out = JSON.parse(await readAllDayBadgesForConcierge(rpcDb(census), BASE, { badge: "", player: null, playerLabels: null, playerId: null }))
    expect(out.mode).toBe("list")
    expect(out.badges.map((b: { title: string }) => b.title)).toEqual(["Rookie Year", "ALL DAY Debut"])
    expect(JSON.stringify(out)).not.toMatch(/Top Shot only/i)
  })
  it("a badge name matches by key; an unknown one is no_results with the real list", async () => {
    const hit = JSON.parse(await readAllDayBadgesForConcierge(rpcDb(census), BASE, { badge: "rookie", player: null, playerLabels: null, playerId: null }))
    expect(hit.matches[0]).toMatchObject({ title: "Rookie Year", all_day_editions_tagged: 1158 })
    const miss = JSON.parse(await readAllDayBadgesForConcierge(rpcDb(census), BASE, { badge: "MVP Year", player: null, playerLabels: null, playerId: null }))
    expect(miss.status).toBe("no_results")
    expect(miss.all_day_badges).toContain("ALL DAY Debut")
  })
  it("a failed census is an error, never 'no badges'", async () => {
    const out = JSON.parse(await readAllDayBadgesForConcierge(rpcDb({ data: null, error: { message: "x" } }), BASE, { badge: "", player: null, playerLabels: null, playerId: null }))
    expect(out.status).toBe("error")
    expect(out.message).toMatch(/says nothing about which badges exist/)
  })
})

describe("readAllDaySetCompletionForConcierge", () => {
  const body = { totalSets: 2, completeSets: 0, sets: [
    { setName: "Base", totalEditions: 300, ownedCount: 20, missingCount: 280, completionPct: 7, totalMissingCost: 81.5, missing: [{ playerName: "A", tier: "COMMON", fmv: 3 }] },
    { setName: "Gridiron", totalEditions: 40, ownedCount: 39, missingCount: 1, completionPct: 98, totalMissingCost: 12, missing: [] },
  ] }
  const ok = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
  it("labels the money as value at FMV, never a cost at the floor", async () => {
    const out = JSON.parse(await readAllDaySetCompletionForConcierge(BASE, "0xb7700366fa738a43", { setName: "base" }, ok))
    expect(out.sets).toHaveLength(1)
    expect(out.sets[0].missing_value_at_fmv_usd).toBe(81.5)
    expect(JSON.stringify(out.sets)).not.toMatch(/cost_to_finish|floor_cost/)
    expect(out.how_to_read).toMatch(/not live asks/)
  })
  it("cheapest-first keeps started, unfinished sets in ascending FMV value", async () => {
    const out = JSON.parse(await readAllDaySetCompletionForConcierge(BASE, "0xb7700366fa738a43", { cheapestFirst: true }, ok))
    expect(out.sets.map((s: { set: string }) => s.set)).toEqual(["Gridiron", "Base"])
  })
  it("a failed read says the check failed", async () => {
    const bad = (async () => new Response("x", { status: 503 })) as unknown as typeof fetch
    const out = JSON.parse(await readAllDaySetCompletionForConcierge(BASE, "0xb7700366fa738a43", {}, bad))
    expect(out.status).toBe("error")
    expect(out.message).toMatch(/never say this wallet has no set progress/)
  })
})

describe("route: each All Day arm returns before the Top Shot read", () => {
  const src = stripComments(readFileSync(join(__dirname, "..", "app", "api", "support-chat", "route.ts"), "utf8"))
  const handler = (name: string) => {
    const start = src.indexOf(`if (toolName === "${name}") {`)
    expect(start, name).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf("\n  if (toolName === ", start + 10))
  }
  it.each([
    ["get_hot_floors", "readAllDayHotFloorsForConcierge", 'rpc("get_topshot_hot_floors"'],
    ["get_edition_sweep", 'allDayNotApplicable("get_edition_sweep"', 'rpc("get_edition_sweep_signal"'],
    ["search_serial_deals", 'allDayNotApplicable("search_serial_deals"', "const player ="],
    ["get_challenges", 'allDayNotApplicable("get_challenges"', "try {"],
    ["get_rookies", 'allDayNotApplicable("get_rookies"', "new URLSearchParams()"],
    ["get_set_completion_cost", "readAllDaySetCompletionForConcierge", 'COLLECTION_UUID_BY_SLUG["nba-top-shot"]'],
    ["get_cheapest_sets_to_complete", "readAllDaySetCompletionForConcierge", "try {"],
    ["get_badge_info", "readAllDayBadgesForConcierge", 'from("badge_taxonomy")'],
  ])("%s", (name, arm, tsRead) => {
    const h = handler(name)
    const a = h.indexOf(arm)
    expect(a, `${name} has no All Day arm`).toBeGreaterThan(-1)
    expect(a, `${name}: All Day arm after the Top Shot read`).toBeLessThan(h.indexOf(tsRead))
  })
  it("special-serial owners passes the collection to the board and links under it", () => {
    const h = handler("get_special_serial_owners")
    expect(h).toContain("p_collection: ssoSlug")
    expect(h).toContain("${base}/${ssoSlug}/edition/")
    expect(h).not.toContain('note: "Top Shot only.')
  })
  it("no badge note claims moment badges are indexed for Top Shot only", () => {
    expect(src).not.toMatch(/indexed for (NBA )?Top Shot only/)
  })
})
