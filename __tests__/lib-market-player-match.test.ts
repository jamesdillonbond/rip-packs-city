import { describe, it, expect, vi } from "vitest"
import { accentOnlyMatches, accentTolerantPattern, resolveAccentedPlayer, withAccentFallback } from "@/lib/market/player-match"

// Known-issues #207 — see lib/market/player-match.ts.

/** Postgres ILIKE semantics for a body wrapped in %…%: % any run, _ one char, \ escapes. */
function ilike(value: string, body: string): boolean {
  let re = ""
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === "\\" && i + 1 < body.length) { re += body[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue }
    re += c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^.*${re}.*$`, "is").test(value)
}

describe("accentOnlyMatches / resolveAccentedPlayer", () => {
  const names = ["Luka Dončić", "Luka Garza", "Nikola Jokić", "Nikola Jović"]
  it("finds only the names an ilike would MISS", () => {
    expect(accentOnlyMatches("doncic", names)).toEqual(["Luka Dončić"])
    expect(accentOnlyMatches("luka", names)).toEqual([])
  })
  it("resolves exactly one; refuses ambiguity and a typed text that already matches", () => {
    expect(resolveAccentedPlayer("luka doncic", names)).toBe("Luka Dončić")
    expect(resolveAccentedPlayer("nikola jo", names)).toBeNull() // matches both as typed → true empty
    expect(resolveAccentedPlayer("jo", ["Nikola Jokić", "Nikola Jović"])).toBeNull()
    expect(resolveAccentedPlayer("ic", ["Nikola Jokić", "Nikola Jović"])).toBeNull() // two accent-only → no guess
    expect(resolveAccentedPlayer("", names)).toBeNull()
  })
})

describe("accentTolerantPattern", () => {
  it("matches the accented spelling under real ILIKE semantics", () => {
    const p = accentTolerantPattern("luka doncic")!
    expect(ilike("Luka Dončić", p)).toBe(true)
    expect(ilike("José Ramírez", accentTolerantPattern("jose ramirez")!)).toBe(true)
    expect(ilike("Atlético de Madrid", accentTolerantPattern("atletico")!)).toBe(true)
  })
  it("covers the measured catalog letters: ø, ģ and the curly apostrophe", () => {
    expect(ilike("Alexander Sørloth", accentTolerantPattern("alexander sorloth")!)).toBe(true)
    expect(ilike("Kristaps Porziņģis", accentTolerantPattern("porzingis")!)).toBe(true)
    expect(ilike("Aiden O’Neill", accentTolerantPattern("aiden o'neill")!)).toBe(true)
  })
  it("resolves an unaccented ø name in the catalog", () => {
    expect(resolveAccentedPlayer("sorloth", ["Alexander Sørloth", "Alexander Isak"])).toBe("Alexander Sørloth")
  })
  it("keeps a typed % or _ literal", () => {
    const p = accentTolerantPattern("a_b%x")
    expect(p).not.toBeNull()
    expect(ilike("a_b%x", p!)).toBe(true)
    expect(ilike("azbqqx", p!)).toBe(false)
  })
  it("returns null when there is nothing to widen or too little left literal", () => {
    expect(accentTolerantPattern("bkd")).toBeNull()
    expect(accentTolerantPattern("ai")).toBeNull()
    expect(accentTolerantPattern("  ")).toBeNull()
  })
})

describe("withAccentFallback", () => {
  const rows = [{ player_name: "José Ramírez" }, { player_name: "Josh Ramirez-Lopez" }, { player_name: "Joey Ramos" }]
  const arm = (body: string) => Promise.resolve(rows.filter((r) => ilike(r.player_name, body)))
  it("a search that matched as typed is returned untouched (one call)", async () => {
    const run = vi.fn(arm)
    expect(await withAccentFallback("ramos", run, (r) => r.player_name)).toEqual([{ player_name: "Joey Ramos" }])
    expect(run).toHaveBeenCalledTimes(1)
  })
  it("an empty search is retried wide, and the fold DECIDES (over-matches dropped)", async () => {
    const run = vi.fn(arm)
    const got = await withAccentFallback("josé ramír", run, (r) => r.player_name)
    expect(run).toHaveBeenCalledTimes(1) // accented query already matched as typed
    expect(got!.map((r) => r.player_name)).toEqual(["José Ramírez"])
    const run2 = vi.fn(arm)
    const got2 = await withAccentFallback("jose ramirez", run2, (r) => r.player_name)
    // "jose ramirez" matched "Josh Ramirez-Lopez"? no — "josh" ≠ "jose"; as typed nothing matched
    expect(run2).toHaveBeenCalledTimes(2)
    expect(got2!.map((r) => r.player_name)).toEqual(["José Ramírez"])
  })
  it("a FAILED read passes through as null — never turned into an empty market", async () => {
    expect(await withAccentFallback("jose", () => Promise.resolve(null), (r: { player_name: string }) => r.player_name)).toBeNull()
    let n = 0
    const flaky = (_b: string) => (n++ === 0 ? Promise.resolve([] as { player_name: string }[]) : Promise.resolve(null))
    expect(await withAccentFallback("jose ramirez", flaky, (r) => r.player_name)).toEqual([])
  })
})
