import { describe, it, expect, vi } from "vitest"

import {
  fetchAllDayScarcityBoard,
  ALLDAY_SCARCITY_COLS,
  ALLDAY_SCARCITY_SORTS,
} from "@/lib/insights/allday-scarcity-board"

// The All Day scarcity query, now shared by the server page and the public API
// route instead of being copied into both.
//
// These tests assert the QUERY SHAPE rather than results, because the shape is
// what the two consumers were duplicating and what would silently drift: the
// column list, the cohort gate, and which column each sort key orders by. A
// wrong sort here reorders a public ranked board without erroring.

/** Records every builder call so the assembled query can be asserted. */
function recordingDb() {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const q: Record<string, unknown> = {}
  for (const fn of ["select", "gte", "gt", "eq", "ilike", "lte", "order"]) {
    q[fn] = (...args: unknown[]) => {
      calls.push({ fn, args })
      return q
    }
  }
  q.limit = (...args: unknown[]) => {
    calls.push({ fn: "limit", args })
    return Promise.resolve({ data: [], error: null })
  }
  const db = {
    from: (...args: unknown[]) => {
      calls.push({ fn: "from", args })
      return q
    },
  }
  return { db, calls }
}

const has = (calls: Array<{ fn: string; args: unknown[] }>, fn: string, arg0?: unknown) =>
  calls.some((c) => c.fn === fn && (arg0 === undefined || c.args[0] === arg0))

describe("fetchAllDayScarcityBoard — query shape", () => {
  it("reads the public board view with the shared column list", async () => {
    const { db, calls } = recordingDb()
    await fetchAllDayScarcityBoard({ limit: 100 }, db)
    expect(has(calls, "from", "allday_scarcity_board")).toBe(true)
    // The duplicated column list was the concrete drift risk this extraction
    // removed: a column added to the route alone would have left the
    // server-rendered HTML missing it.
    expect(calls.find((c) => c.fn === "select")?.args[0]).toBe(ALLDAY_SCARCITY_COLS)
  })

  it("applies the cohort gate by default — family_size >= 3 and scarcity > 0", async () => {
    const { db, calls } = recordingDb()
    await fetchAllDayScarcityBoard({ limit: 100 }, db)
    // Without the family_size floor the "average family mint" is computed off
    // one or two members and the board ranks noise as scarcity.
    expect(calls.some((c) => c.fn === "gte" && c.args[0] === "family_size" && c.args[1] === 3)).toBe(true)
    expect(
      calls.some((c) => c.fn === "gt" && c.args[0] === "scarcity_vs_family_pct" && c.args[1] === 0),
    ).toBe(true)
  })

  it("honours explicit cohort overrides, including 0", async () => {
    const { db, calls } = recordingDb()
    await fetchAllDayScarcityBoard({ limit: 10, minFamilySize: 0, minScarcity: -5 }, db)
    // 0 must survive: a caller asking for no floor must not silently get 3 back
    // via a `||` default.
    expect(calls.some((c) => c.fn === "gte" && c.args[1] === 0)).toBe(true)
    expect(calls.some((c) => c.fn === "gt" && c.args[1] === -5)).toBe(true)
  })

  it("skips the optional filters when they are absent", async () => {
    const { db, calls } = recordingDb()
    await fetchAllDayScarcityBoard({ limit: 100 }, db)
    expect(has(calls, "eq")).toBe(false)
    expect(has(calls, "ilike")).toBe(false)
    expect(has(calls, "lte")).toBe(false)
  })

  it("upper-cases the tier — the column stores uppercase", async () => {
    const { db, calls } = recordingDb()
    await fetchAllDayScarcityBoard({ limit: 100, tier: "legendary" }, db)
    expect(calls.some((c) => c.fn === "eq" && c.args[0] === "tier" && c.args[1] === "LEGENDARY")).toBe(true)
  })

  it("matches set names loosely, on both sides", async () => {
    const { db, calls } = recordingDb()
    await fetchAllDayScarcityBoard({ limit: 100, set: "base" }, db)
    expect(calls.some((c) => c.fn === "ilike" && c.args[1] === "%base%")).toBe(true)
  })

  it("ignores a non-finite max_mint rather than passing NaN to the query", async () => {
    const { db, calls } = recordingDb()
    await fetchAllDayScarcityBoard({ limit: 100, maxMint: Number.NaN }, db)
    expect(has(calls, "lte")).toBe(false)
  })

  it("each sort key orders by its own column — a swap silently reorders a public board", async () => {
    for (const [sort, col] of [
      ["scarcity", "scarcity_vs_family_pct"],
      ["mint", "mint_count"],
      ["fmv", "fmv_usd"],
    ] as const) {
      const { db, calls } = recordingDb()
      await fetchAllDayScarcityBoard({ limit: 100, sort }, db)
      const order = calls.find((c) => c.fn === "order")
      expect(order?.args[0], `sort=${sort} must order by ${col}`).toBe(col)
    }
    expect([...ALLDAY_SCARCITY_SORTS].sort()).toEqual(["fmv", "mint", "scarcity"])
  })

  it("sorts mint ASCENDING — scarcest first — and the others descending", async () => {
    const { db: d1, calls: c1 } = recordingDb()
    await fetchAllDayScarcityBoard({ limit: 100, sort: "mint" }, d1)
    expect(c1.find((c) => c.fn === "order")?.args[1]).toMatchObject({ ascending: true })

    const { db: d2, calls: c2 } = recordingDb()
    await fetchAllDayScarcityBoard({ limit: 100, sort: "fmv" }, d2)
    // nullsFirst:false keeps unpriced rows off the top of a value ranking —
    // presenting "we have no price" as "this is the most valuable".
    expect(c2.find((c) => c.fn === "order")?.args[1]).toMatchObject({
      ascending: false,
      nullsFirst: false,
    })
  })

  it("an unknown sort applies NO order rather than guessing one", async () => {
    const { db, calls } = recordingDb()
    await fetchAllDayScarcityBoard({ limit: 100, sort: "bogus" }, db)
    expect(has(calls, "order")).toBe(false)
  })

  it("always applies the caller's limit", async () => {
    const { db, calls } = recordingDb()
    await fetchAllDayScarcityBoard({ limit: 37 }, db)
    expect(calls.find((c) => c.fn === "limit")?.args[0]).toBe(37)
  })

  it("returns supabase's { data, error } untouched so each caller keeps its own policy", async () => {
    // The route needs the raw error for boardUnavailable() (503, no driver
    // message leaked); the page needs it for the degraded notice. Normalising
    // here would force one of them to re-derive what it lost.
    const err = { message: "canceling statement due to statement timeout" }
    const db = {
      from: () => ({
        select: () => ({
          gte: () => ({
            gt: () => ({
              order: () => ({ limit: () => Promise.resolve({ data: null, error: err }) }),
            }),
          }),
        }),
      }),
    }
    await expect(fetchAllDayScarcityBoard({ limit: 5 }, db)).resolves.toEqual({
      data: null,
      error: err,
    })
  })
})

describe("the page and the route now share one query", () => {
  it("neither consumer keeps its own copy of the column list", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const page = readFileSync(
      join(process.cwd(), "app", "insights", "allday-scarcity", "page.tsx"),
      "utf8",
    )
    const route = readFileSync(
      join(process.cwd(), "app", "api", "public", "insights", "allday-scarcity", "route.ts"),
      "utf8",
    )
    // The page's comment used to claim it read the view "exactly as the API
    // route does". Nothing enforced that; this does.
    for (const [name, src] of [
      ["page", page],
      ["route", route],
    ] as const) {
      expect(src, `${name} must not redeclare SELECT_COLS`).not.toMatch(/const SELECT_COLS\s*=/)
      expect(src, `${name} must not query the view directly`).not.toContain(
        'from("allday_scarcity_board")',
      )
      expect(src, `${name} must use the shared fetcher`).toContain("fetchAllDayScarcityBoard")
    }
  })
})
