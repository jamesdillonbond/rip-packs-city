// #175 (2026-10-10): a Top Shot edition key that is an ALIAS of another key —
// the API's `149:<play>::8` for the chain's `152:<play>` — 308s to the canonical
// page that holds the sales, owners and market. Table: topshot_edition_aliases
// (migration 20261010155627, 25 rows). Unlike the fossil redirect, an alias
// edition EXISTS, so a miss / error / timeout renders the alias page as before:
// never a guessed 308, never a 404.
//
// Contract pinned here:
//   1. a hit returns the canonical key;
//   2. a miss returns null (the page renders the alias);
//   3. a DB error returns null — a failed read is never a guessed redirect;
//   4. a lookup that hangs past the budget returns null;
//   5. a non-key shape never touches the DB (a fossil UUID pair, a hostile string);
//   6. a malformed or self-referencing canonical from the table is refused.
// Plus source pins: the segment LAYOUT (the gate that runs before the first
// flush) and BOTH page gates consult the lookup for Top Shot and permanentRedirect
// on a hit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const state: { row: { canonical_external_id: unknown } | null; error: { message: string } | null; calls: number; hang: boolean; eqArg: unknown } = {
  row: null,
  error: null,
  calls: 0,
  hang: false,
  eqArg: null,
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
  const client: any = { from: () => build() }
  return { supabase: client, supabaseAdmin: client }
})

import { lookupTopShotEditionAliasRedirect, isTopShotEditionKeyShape, ALIAS_REDIRECT_TIMEOUT_MS } from "@/lib/edition/alias-redirect"

const ALIAS = "149:5370::8"

beforeEach(() => {
  state.row = null
  state.error = null
  state.calls = 0
  state.hang = false
  state.eqArg = null
})
afterEach(() => vi.useRealTimers())

describe("lookupTopShotEditionAliasRedirect", () => {
  it("1. returns the canonical key on a hit", async () => {
    state.row = { canonical_external_id: "152:5370" }
    expect(await lookupTopShotEditionAliasRedirect(ALIAS)).toBe("152:5370")
    expect(state.eqArg).toBe(ALIAS)
    expect(state.calls).toBe(1)
  })

  it("2. returns null on a miss — the page renders the key it was given", async () => {
    expect(await lookupTopShotEditionAliasRedirect("152:5370")).toBeNull()
    expect(state.calls).toBe(1)
  })

  it("3. returns null on a DB error — a failed read is never a guessed 308", async () => {
    state.error = { message: "canceling statement due to statement timeout" }
    state.row = { canonical_external_id: "152:5370" }
    expect(await lookupTopShotEditionAliasRedirect(ALIAS)).toBeNull()
  })

  it("4. returns null when the lookup hangs past its budget", async () => {
    vi.useFakeTimers()
    state.hang = true
    const p = lookupTopShotEditionAliasRedirect(ALIAS)
    await vi.advanceTimersByTimeAsync(ALIAS_REDIRECT_TIMEOUT_MS + 1)
    expect(await p).toBeNull()
  })

  it("5. never reads the DB for a non-key shape", async () => {
    state.row = { canonical_external_id: "152:5370" }
    for (const s of [
      "4a3f9cc3-8218-4737-9e99-6ba83296e2e7:56164142-0fe2-4f10-9b8b-14f220df808b",
      "ANDRE-FILI-UFC-296-KO-TKO-1500",
      "'; drop table x; --",
      "149:5370::8::1",
      "",
    ]) {
      expect(isTopShotEditionKeyShape(s)).toBe(false)
      expect(await lookupTopShotEditionAliasRedirect(s)).toBeNull()
    }
    expect(state.calls).toBe(0)
  })

  it("6. refuses a malformed or self-referencing canonical from the table", async () => {
    state.row = { canonical_external_id: "https://evil.example/" }
    expect(await lookupTopShotEditionAliasRedirect(ALIAS)).toBeNull()
    state.row = { canonical_external_id: 42 }
    expect(await lookupTopShotEditionAliasRedirect(ALIAS)).toBeNull()
    state.row = { canonical_external_id: ALIAS }
    expect(await lookupTopShotEditionAliasRedirect(ALIAS)).toBeNull()
  })
})

describe("edition route: the layout and both page gates consult the alias lookup", () => {
  const REDIRECT = /if \(canonical\) permanentRedirect\(`\/\$\{collection\}\/edition\/\$\{encodeURIComponent\(canonical\)\}`\)/

  it("the segment LAYOUT 308s an alias before the first flush, and does not 404 a miss", () => {
    const layout = readFileSync(join(process.cwd(), "app/(collections)/[collection]/edition/[slug]/layout.tsx"), "utf8")
    expect(layout).toContain('from "@/lib/edition/alias-redirect"')
    const arms = layout.split("await lookupTopShotEditionAliasRedirect(slug)")
    expect(arms.length, "exactly one alias arm in the layout").toBe(2)
    expect(arms[0].slice(-300)).toContain('if (collection === "nba-top-shot")')
    const after = arms[1].slice(0, 200)
    expect(after).toMatch(REDIRECT)
    // the alias arm is followed by the existence gate, not a notFound() of its own
    expect(after.split("\n").slice(0, 3).join("\n")).not.toContain("notFound()")
    expect(layout.indexOf("lookupTopShotEditionAliasRedirect(slug)")).toBeLessThan(layout.indexOf('entityResolves("edition"'))
  })

  it("both page gates (generateMetadata + page body) consult the lookup and permanentRedirect on a hit", () => {
    const src = readFileSync(join(process.cwd(), "app/(collections)/[collection]/edition/[slug]/page.tsx"), "utf8")
    expect(src).toContain('from "@/lib/edition/alias-redirect"')
    const arms = src.split("await lookupTopShotEditionAliasRedirect(slug)").slice(1)
    expect(arms.length, "expected the two alias arms (metadata + page)").toBe(2)
    for (const after of arms) expect(after.slice(0, 200)).toMatch(REDIRECT)
  })
})
