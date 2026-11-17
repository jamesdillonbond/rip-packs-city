// #247 (2026-11-13): a Candy edition key that is an ALIAS of the card's canonical key (one card was stored
// under several keys: the 32-char on-chain name cut, the full off-chain title, older slugging) 308s to the
// canonical page, where its holdings, sales, listings and offers now live. Table: candy_edition_key_aliases.
// Same contract as the Top Shot alias redirect (#175): a hit -> canonical; a miss, an error, a hang -> null
// (the page renders as before: never a guessed 308, never a 404); a non-key shape never touches the DB; a
// malformed or self-referencing canonical is refused. Plus source pins: the layout and both page gates.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const state: { row: { canonical_key: unknown } | null; error: { message: string } | null; calls: number; hang: boolean; eqArg: unknown; table: string | null } = {
  row: null, error: null, calls: 0, hang: false, eqArg: null, table: null,
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      eq: (_col: string, val: unknown) => {
        state.eqArg = val
        return b
      },
      maybeSingle: () => {
        state.calls += 1
        if (state.hang) return new Promise(() => {})
        return Promise.resolve({ data: state.row, error: state.error })
      },
    }
    return b
  }
  const client: any = { from: (t: string) => { state.table = t; return build() } }
  return { supabase: client, supabaseAdmin: client }
})

import { lookupCandyEditionAliasRedirect, isCandyEditionKeyShape } from "@/lib/edition/alias-redirect"

const ALIAS = "c:dc3-super-power-packs-series-justice-league-vs-s:justice-league-vs-suicide-sq-1-core"
const CANON = "c:dc3-super-power-packs-series-justice-league-vs-s:justice-league-vs-suicid-1-core"

beforeEach(() => {
  state.row = null; state.error = null; state.calls = 0; state.hang = false; state.eqArg = null; state.table = null
})

describe("lookupCandyEditionAliasRedirect", () => {
  it("a hit returns the canonical key, read from candy_edition_key_aliases", async () => {
    state.row = { canonical_key: CANON }
    expect(await lookupCandyEditionAliasRedirect(ALIAS)).toBe(CANON)
    expect(state.table).toBe("candy_edition_key_aliases")
    expect(state.eqArg).toBe(ALIAS)
  })

  it("a miss and a DB error both return null (never a guessed 308)", async () => {
    expect(await lookupCandyEditionAliasRedirect(`${ALIAS}x`)).toBeNull()
    state.error = { message: "canceling statement due to statement timeout" }
    state.row = { canonical_key: CANON }
    expect(await lookupCandyEditionAliasRedirect(`${ALIAS}y`)).toBeNull()
  })

  it("a lookup that hangs past the budget returns null", async () => {
    vi.useFakeTimers()
    try {
      state.hang = true
      const p = lookupCandyEditionAliasRedirect(`${ALIAS}z`)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await p).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a non-key shape never touches the DB (Base Series keys, hostile strings)", async () => {
    for (const s of ["mike-trout-2022", "c:onlyprefix", "'; drop table x; --", "C:UPPER:case"]) {
      expect(isCandyEditionKeyShape(s)).toBe(false)
      expect(await lookupCandyEditionAliasRedirect(s)).toBeNull()
    }
    expect(state.calls).toBe(0)
  })

  it("a malformed or self-referencing canonical is refused", async () => {
    state.row = { canonical_key: "https://evil.example/x" }
    expect(await lookupCandyEditionAliasRedirect(`${ALIAS}-a`)).toBeNull()
    state.row = { canonical_key: `${ALIAS}-b` }
    expect(await lookupCandyEditionAliasRedirect(`${ALIAS}-b`)).toBeNull()
  })
})

describe("the edition route consults it for Candy before the first flush", () => {
  const dir = join(process.cwd(), "app/(collections)/[collection]/edition/[slug]")
  const block = /if \(collection === "candy-mlb"\) \{\s*(?:\/\/[^\n]*\n\s*)*const canonical = await lookupCandyEditionAliasRedirect\(slug\)\s*if \(canonical\) permanentRedirect\(/g
  it("the layout gate", () => {
    expect(readFileSync(join(dir, "layout.tsx"), "utf8").match(block)?.length).toBe(1)
  })
  it("generateMetadata and the page", () => {
    expect(readFileSync(join(dir, "page.tsx"), "utf8").match(block)?.length).toBe(2)
  })
})
