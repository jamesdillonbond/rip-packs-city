// 2026-11-15: a retired shared Candy 1-of-1 key (`…:paul-skenes-legendary`, deleted after the 11-09 per-mint
// re-key) 308s to its successor ONLY when exactly one per-mint edition (`…-legendary-<suffix>`) exists. Two or more
// would be a guess (substitution), a capped read cannot prove "one", and an error or hang keeps the 404.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const state: {
  rows: Array<{ external_id: unknown }> | null
  error: { message: string } | null
  hang: boolean
  like: string | null
  eqs: Array<[string, unknown]>
  table: string | null
  calls: number
} = { rows: [], error: null, hang: false, like: null, eqs: [], table: null, calls: 0 }

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        state.eqs.push([c, v])
        return b
      },
      like: (_c: string, p: string) => {
        state.like = p
        return b
      },
      limit: () => {
        state.calls += 1
        if (state.hang) return new Promise(() => {})
        return Promise.resolve({ data: state.rows, error: state.error })
      },
    }
    return b
  }
  const client: any = { from: (t: string) => { state.table = t; return build() } }
  return { supabase: client, supabaseAdmin: client }
})

import { lookupCandyOneOfOneSuccessorRedirect } from "@/lib/edition/alias-redirect"

const OLD = "c:2025-mlb-starting-9-icons:paul-skenes-legendary"
const NEW = `${OLD}-H8YmcBdNXaNZ`

beforeEach(() => {
  state.rows = []
  state.error = null
  state.hang = false
  state.like = null
  state.eqs = []
  state.table = null
  state.calls = 0
})

describe("lookupCandyOneOfOneSuccessorRedirect", () => {
  it("exactly one per-mint successor -> that key, read from Candy editions by prefix", async () => {
    state.rows = [{ external_id: NEW }, { external_id: `${OLD}-core` }]
    expect(await lookupCandyOneOfOneSuccessorRedirect(OLD)).toBe(NEW)
    expect(state.table).toBe("editions")
    expect(state.eqs).toContainEqual(["collection_id", "209ade70-32c5-4470-bc7c-4793d660f713"])
    expect(state.like).toBe(`${OLD}-%`)
  })

  it("two successors (a shared key that split) -> null, never a guessed card", async () => {
    const k = "c:2022-all-star-tricons:2022-tricon-castillo-cooper-mc"
    state.rows = [{ external_id: `${k}-AAAAAAAAAAAA` }, { external_id: `${k}-BBBBBBBBBBBB` }]
    expect(await lookupCandyOneOfOneSuccessorRedirect(k)).toBeNull()
  })

  it("siblings that are not a per-mint suffix do not count (core/epic/rare tiers, deeper keys)", async () => {
    const k = "c:2021-all-star-icons:freddy-peralta"
    state.rows = [
      { external_id: `${k}-core` },
      { external_id: `${k}-epic` },
      { external_id: `${k}-legendary-CrPoZDS6kTSH` },
    ]
    expect(await lookupCandyOneOfOneSuccessorRedirect(k)).toBeNull()
  })

  it("a capped read cannot prove 'exactly one' -> null", async () => {
    const k = "c:2025-all-star-icons:zach-mckinstry-legendary"
    state.rows = [{ external_id: `${k}-3RTp8JFGXneM` }, ...Array.from({ length: 49 }, (_, i) => ({ external_id: `${k}-x${i}` }))]
    expect(await lookupCandyOneOfOneSuccessorRedirect(k)).toBeNull()
  })

  it("a DB error -> null (the page 404s as before)", async () => {
    const k = "c:2022-all-star-icons:luis-castillo-legendary"
    state.rows = [{ external_id: `${k}-ABCDEFGHIJKL` }]
    state.error = { message: "canceling statement due to statement timeout" }
    expect(await lookupCandyOneOfOneSuccessorRedirect(k)).toBeNull()
  })

  it("a read that hangs past the budget -> null", async () => {
    state.hang = true
    expect(await lookupCandyOneOfOneSuccessorRedirect("c:2022-all-star-icons:paul-blackburn-legendary")).toBeNull()
  }, 10_000)

  it("escapes LIKE metacharacters in the key (a Candy key may contain _)", async () => {
    const k = "c:coll_x:card_name-legendary"
    state.rows = []
    await lookupCandyOneOfOneSuccessorRedirect(k)
    expect(state.like).toBe("c:coll\\_x:card\\_name-legendary-%")
  })

  it("a non-Candy-key shape never touches the DB", async () => {
    expect(await lookupCandyOneOfOneSuccessorRedirect("../etc/passwd")).toBeNull()
    expect(state.calls).toBe(0)
  })
})

describe("source pin: the layout asks only on the miss path, before notFound()", () => {
  const src = readFileSync(join(process.cwd(), "app/(collections)/[collection]/edition/[slug]/layout.tsx"), "utf8")
  it("the successor lookup sits inside the entityResolves=false branch and precedes notFound()", () => {
    const miss = src.indexOf('if (!(await entityResolves("edition", coll.id, slug))) {')
    expect(miss).toBeGreaterThan(-1)
    const call = src.indexOf("lookupCandyOneOfOneSuccessorRedirect(slug)", miss)
    const nf = src.indexOf("notFound()", miss)
    expect(call).toBeGreaterThan(miss)
    expect(nf).toBeGreaterThan(call)
    // and nowhere before the miss branch (a live edition never pays for the read)
    expect(src.slice(0, miss)).not.toContain("lookupCandyOneOfOneSuccessorRedirect(")
  })
})
