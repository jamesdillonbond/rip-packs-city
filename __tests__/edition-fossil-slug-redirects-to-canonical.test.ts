// A purged UUID-form Top Shot edition key 308s to its canonical page when the
// mapping is unambiguous, and keeps its honest 404 otherwise — including when
// the lookup itself fails. Search Console 2026-10-03: 285 such 404s, 17
// "Google chose different canonical"; table: topshot_edition_uuid_redirects
// (20261003163012, 4,447 unambiguous rows of 6,597 fossils).
//
// Contract pinned here:
//   1. a hit returns the canonical `setID:playID`;
//   2. a miss returns null (the page then notFound()s as before);
//   3. a DB error returns null — a failed read is never a guessed redirect;
//   4. a lookup that hangs past the budget returns null;
//   5. a non-fossil shape never touches the DB (a canonical key, a UFC uuid-ish
//      key, a hostile string);
//   6. a malformed canonical_slug in the table (not `n:n`) is refused.
// Plus a source pin: BOTH gates in the edition page (generateMetadata and the
// page body) consult the lookup BEFORE they 404 a fossil.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const state: { row: { canonical_slug: unknown } | null; error: { message: string } | null; calls: number; hang: boolean; eqArg: unknown } = {
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

import { lookupTopShotFossilRedirect, isTopShotFossilKeyShape, FOSSIL_REDIRECT_TIMEOUT_MS } from "@/lib/edition/fossil-redirect"

const FOSSIL = "4a3f9cc3-8218-4737-9e99-6ba83296e2e7:56164142-0fe2-4f10-9b8b-14f220df808b"

beforeEach(() => {
  state.row = null
  state.error = null
  state.calls = 0
  state.hang = false
  state.eqArg = null
})
afterEach(() => vi.useRealTimers())

describe("lookupTopShotFossilRedirect", () => {
  it("returns the canonical key on a hit (lower-cased lookup)", async () => {
    state.row = { canonical_slug: "258:8692" }
    expect(await lookupTopShotFossilRedirect(FOSSIL.toUpperCase())).toBe("258:8692")
    expect(state.eqArg).toBe(FOSSIL)
    expect(state.calls).toBe(1)
  })

  it("returns null on a miss — the page keeps its 404", async () => {
    expect(await lookupTopShotFossilRedirect(FOSSIL)).toBeNull()
    expect(state.calls).toBe(1)
  })

  it("returns null on a DB error — a failed read is never a guessed 308", async () => {
    state.error = { message: "canceling statement due to statement timeout" }
    state.row = { canonical_slug: "258:8692" }
    expect(await lookupTopShotFossilRedirect(FOSSIL)).toBeNull()
  })

  it("returns null when the lookup hangs past its budget", async () => {
    vi.useFakeTimers()
    state.hang = true
    const p = lookupTopShotFossilRedirect(FOSSIL)
    await vi.advanceTimersByTimeAsync(FOSSIL_REDIRECT_TIMEOUT_MS + 1)
    expect(await p).toBeNull()
  })

  it("never reads the DB for a non-fossil shape", async () => {
    state.row = { canonical_slug: "258:8692" }
    for (const s of ["258:8692", "258:8692::3", "ANDRE-FILI-UFC-296-KO-TKO-1500", "'; drop table x; --", ""]) {
      expect(isTopShotFossilKeyShape(s)).toBe(false)
      expect(await lookupTopShotFossilRedirect(s)).toBeNull()
    }
    expect(state.calls).toBe(0)
  })

  it("refuses a malformed canonical value from the table", async () => {
    state.row = { canonical_slug: "https://evil.example/" }
    expect(await lookupTopShotFossilRedirect(FOSSIL)).toBeNull()
    state.row = { canonical_slug: 42 }
    expect(await lookupTopShotFossilRedirect(FOSSIL)).toBeNull()
  })
})

describe("edition page: both fossil gates consult the redirect before they 404", () => {
  const src = readFileSync(join(process.cwd(), "app/(collections)/[collection]/edition/[slug]/page.tsx"), "utf8")

  it("imports the lookup", () => {
    expect(src).toContain('from "@/lib/edition/fossil-redirect"')
  })

  it("every isTopShotFossilSlug gate awaits lookupTopShotFossilRedirect and permanentRedirects on a hit", () => {
    const gates = src.split("isTopShotFossilSlug(collection, slug)").slice(1)
    expect(gates.length, "expected the two fossil gates (metadata + page)").toBe(2)
    for (const after of gates) {
      const window = after.slice(0, 500)
      expect(window).toContain("await lookupTopShotFossilRedirect(slug)")
      expect(window).toMatch(/if \(canonical\) permanentRedirect\(`\/\$\{collection\}\/edition\/\$\{encodeURIComponent\(canonical\)\}`\)/)
    }
  })

  it("the segment LAYOUT — the gate that actually runs first — consults the lookup before its own 404", () => {
    const layout = readFileSync(join(process.cwd(), "app/(collections)/[collection]/edition/[slug]/layout.tsx"), "utf8")
    expect(layout).toContain('from "@/lib/edition/fossil-redirect"')
    const after = layout.split('if (collection === "nba-top-shot" && slug.includes("-"))').slice(1)
    expect(after.length).toBe(1)
    const window = after[0].slice(0, 400)
    expect(window).toContain("await lookupTopShotFossilRedirect(slug)")
    expect(window).toMatch(/if \(canonical\) permanentRedirect\(`\/\$\{collection\}\/edition\/\$\{encodeURIComponent\(canonical\)\}`\)/)
    expect(window).toContain("notFound()")
  })

  it("a fossil with no mapping still 404s (notFound / NOT_FOUND_METADATA remain after the lookup)", () => {
    const gates = src.split("isTopShotFossilSlug(collection, slug)").slice(1)
    expect(gates[0].slice(0, 600)).toContain("return NOT_FOUND_METADATA")
    expect(gates[1].slice(0, 600)).toContain("notFound()")
  })
})
