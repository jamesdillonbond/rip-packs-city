import { describe, it, expect } from "vitest"
import { accentInsensitiveRegex } from "@/lib/search/accent-regex"

// The regex is run by Postgres (`~*`); JS's `iu` regex is the same language for
// these classes, so it stands in for the database here.
const matches = (typed: string, title: string) => new RegExp(accentInsensitiveRegex(typed)!, "iu").test(title)

describe("accentInsensitiveRegex", () => {
  it("matches the accented title from unaccented typing, and only real matches", () => {
    expect(matches("clasico", "ElClásico Challenge 3/3 - Real Reward")).toBe(true)
    expect(matches("CLASICO", "ElClásico")).toBe(true)
    expect(matches("doncic", "Run It Back: Origins 2014-19 Luka Dončić Expert Challenge Reward")).toBe(true)
    expect(matches("niederhauser", "Yanic Konan Niederhäuser Freshman Gems")).toBe(true)
    expect(matches("clasico", "Classic Collection")).toBe(false)
    expect(matches("de'aaron", "2022-23 Honors: De’Aaron Fox Leaderboard Reward")).toBe(true)
    // Pinnacle characters (2026-10-22): the fold drops joiners, so they may sit between letters.
    expect(matches("walle", "WALL•E")).toBe(true)
    expect(matches("padme", "Padmé Amidala")).toBe(true)
    expect(matches("lumiere", "Lumière")).toBe(true)
  })

  it("escapes regex metacharacters in what was typed", () => {
    const rx = accentInsensitiveRegex("vol.2 (a)")!
    expect(new RegExp(rx, "iu").test("Star Wars™ May the 4th Vol.2 (A)")).toBe(true)
    expect(new RegExp(rx, "iu").test("Vol22 xax")).toBe(false)
  })

  it("is null when nothing typed can carry an accent, or nothing was typed", () => {
    expect(accentInsensitiveRegex("123 #1")).toBeNull()
    expect(accentInsensitiveRegex("   ")).toBeNull()
  })
})

describe("retryEmptyWithAccentRegex", () => {
  it("re-runs only an empty, non-failed search; a matched or failed one is returned as is", async () => {
    const { retryEmptyWithAccentRegex } = await import("@/lib/search/accent-regex")
    const run = async (rx: string) => ({ data: ["Padmé Amidala"].filter((n) => new RegExp(rx, "iu").test(n)), error: null })
    expect((await retryEmptyWithAccentRegex("padme", { data: [], error: null }, run)).data).toEqual(["Padmé Amidala"])
    const matched = { data: ["x"], error: null }
    expect(await retryEmptyWithAccentRegex("padme", matched, run)).toBe(matched)
    const failed = { data: null, error: { message: "boom" } }
    expect(await retryEmptyWithAccentRegex("padme", failed, run)).toBe(failed)
    const retryFails = async () => ({ data: null, error: { message: "boom" } })
    expect((await retryEmptyWithAccentRegex("padme", { data: [], error: null }, retryFails)).data).toEqual([])
  })
})

describe("retryEmptyWithAccentRegex — a throwing retry", () => {
  it("leaves the original empty answer standing", async () => {
    const { retryEmptyWithAccentRegex } = await import("@/lib/search/accent-regex")
    const first = { data: [] as string[], error: null }
    expect(await retryEmptyWithAccentRegex("padme", first, () => { throw new Error("no .filter on this client") })).toBe(first)
  })
})
