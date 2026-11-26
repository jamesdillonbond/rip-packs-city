import { describe, it, expect } from "vitest"
import { fetchSqueezeDefault, SQUEEZE_PAGE_DEFAULT } from "@/lib/insights/squeeze-board"

// fetchSqueezeDefault is the `squeeze` board's builder (2026-11-26): the page reads it
// through readBoardOrLive and the warm cron writes it into public_board_snapshots.
// What must hold, because the ladder trusts it:
//   · a FAILED read is ok:false (so it is never cached) and carries NO freshness stamp
//     and NO rows — a failure must not be cached as "nothing is squeezed";
//   · a successful read is ok:true with the rows and a real read time;
//   · a successful EMPTY read is still ok:true (a genuinely empty board is a fact).

/** A chainable PostgREST stand-in: every builder method returns itself, awaiting resolves `result`. */
function db(result: { data: unknown[] | null; error: { message: string } | null }) {
  const calls: { method: string; args: unknown[] }[] = []
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result)
        return (...args: unknown[]) => {
          calls.push({ method: prop, args })
          return chain
        }
      },
    },
  )
  return { client: { from: (view: string) => (calls.push({ method: "from", args: [view] }), chain) }, calls }
}

describe("fetchSqueezeDefault (the squeeze board's cached default view)", () => {
  it("a failed read is not cacheable and claims no freshness and no rows", async () => {
    const { client } = db({ data: null, error: { message: "canceling statement due to statement timeout" } })
    const res = await fetchSqueezeDefault(client)
    expect(res.ok).toBe(false)
    expect(res.payload.fetched_at).toBeNull()
    expect(res.payload.rows).toEqual([])
    expect(res.rowCount).toBeNull()
    expect(res.error).toContain("topshot_squeeze_board")
    expect(res.error).toContain("statement timeout")
  })

  it("a successful read is cacheable, with its rows and a real read time", async () => {
    const { client, calls } = db({ data: [{ edition_id: "a" }, { edition_id: "b" }], error: null })
    const before = Date.now()
    const res = await fetchSqueezeDefault(client)
    expect(res.ok).toBe(true)
    expect(res.payload.rows).toHaveLength(2)
    expect(res.rowCount).toBe(2)
    expect(res.error).toBeUndefined()
    const t = new Date(res.payload.fetched_at as string).getTime()
    expect(t).toBeGreaterThanOrEqual(before)
    // It reads the page's own default view: the Top Shot board, 50%+ squeezed, top 200.
    expect(calls[0]).toEqual({ method: "from", args: ["topshot_squeeze_board"] })
    expect(calls).toContainEqual({ method: "gte", args: ["squeeze_pct", SQUEEZE_PAGE_DEFAULT.minSqueeze] })
    expect(calls).toContainEqual({ method: "limit", args: [SQUEEZE_PAGE_DEFAULT.limit] })
  })

  it("a successful EMPTY read is still a fact (ok, zero rows), not a failure", async () => {
    const { client } = db({ data: [], error: null })
    const res = await fetchSqueezeDefault(client)
    expect(res.ok).toBe(true)
    expect(res.payload.rows).toEqual([])
    expect(res.rowCount).toBe(0)
    expect(res.payload.fetched_at).not.toBeNull()
  })
})
