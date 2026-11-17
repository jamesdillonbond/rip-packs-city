import { describe, it, expect } from "vitest"
import { recordDeliveredInWalletCache, type DeliveredMoment } from "@/lib/giveaways/wallet-cache"
import type { PoolRow } from "@/lib/giveaways/store"

// A delivered giveaway Moment goes into its winner's wallet cache, named
// (2026-11-10: rrx69's Dame Time pack rendered as two "Unknown Set" rows).

type Row = Record<string, unknown>
type Call = { table: string; op: string; payload?: unknown; filters: [string, string, unknown][] }

function fakeDb(rows: Row[], fail: Partial<Record<"existing" | "anchor" | "insert" | "update" | "rpc", string>> = {}) {
  const calls: Call[] = []
  const rpcs: unknown[] = []
  const match = (r: Row, f: [string, string, unknown][]) =>
    f.every(([op, col, v]) =>
      op === "eq" ? r[col] === v : op === "in" ? (v as unknown[]).includes(r[col]) : op === "is" ? r[col] == null : op === "not" ? r[col] != null : true,
    )
  const builder = (table: string) => {
    const c: Call = { table, op: "select", filters: [] }
    let order: { col: string; asc: boolean } | null = null
    let lim: number | null = null
    let cols = ""
    const run = () => {
      calls.push(c)
      if (c.op === "select") {
        if (cols.includes("last_seen_at") && fail.anchor) return { data: null, error: { message: fail.anchor } }
        if (cols.includes("edition_key") && fail.existing) return { data: null, error: { message: fail.existing } }
        let out = rows.filter((r) => match(r, c.filters))
        if (order) out = [...out].sort((a, b) => String(b[order!.col]).localeCompare(String(a[order!.col])) * (order!.asc ? -1 : 1))
        if (lim != null) out = out.slice(0, lim)
        return { data: out, error: null }
      }
      if (c.op === "upsert") {
        if (fail.insert) return { data: null, error: { message: fail.insert } }
        const added: Row[] = []
        for (const r of c.payload as Row[]) {
          if (rows.some((x) => x.wallet_address === r.wallet_address && x.collection_id === r.collection_id && x.moment_id === r.moment_id)) continue
          rows.push({ ...r }); added.push(r)
        }
        return { data: added.map((r) => ({ moment_id: r.moment_id })), error: null }
      }
      if (c.op === "update") {
        if (fail.update) return { data: null, error: { message: fail.update } }
        const hit = rows.filter((r) => match(r, c.filters))
        for (const r of hit) Object.assign(r, c.payload as Row)
        return { data: hit.map((r) => ({ moment_id: r.moment_id })), error: null }
      }
      return { data: null, error: null }
    }
    const q: any = {
      select: (s: string) => { if (c.op === "select") cols = s; return q },
      eq: (col: string, v: unknown) => { c.filters.push(["eq", col, v]); return q },
      in: (col: string, v: unknown) => { c.filters.push(["in", col, v]); return q },
      is: (col: string) => { c.filters.push(["is", col, null]); return q },
      not: (col: string) => { c.filters.push(["not", col, null]); return q },
      order: (col: string, o: { ascending: boolean }) => { order = { col, asc: o.ascending }; return q },
      limit: (n: number) => { lim = n; return q },
      upsert: (p: unknown) => { c.op = "upsert"; c.payload = p; return q },
      update: (p: unknown) => { c.op = "update"; c.payload = p; return q },
      then: (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(run()).then(res, rej),
    }
    return q
  }
  const db = {
    from: (t: string) => builder(t),
    rpc: (name: string, args: unknown) => { rpcs.push({ name, args }); return Promise.resolve(fail.rpc ? { data: null, error: { message: fail.rpc } } : { data: 1, error: null }) },
  }
  return { db: db as never, rows, calls, rpcs }
}

const COL = "col-ts"
const W = "0x00000000000000aa"
const pm = (id: string, over: Partial<PoolRow> = {}): PoolRow => ({
  moment_id: id, pack_no: 1, slot: 1, edition_key: "26:559", player_name: "Damian Lillard", set_name: "Base Set", team_name: "Portland Trail Blazers",
  tier: "COMMON", serial_number: 8381, fmv_usd: 0.24, image_url: "https://x/img", delivered_at: "2026-11-10T01:13:17Z",
  last_checked_at: null, last_check_recipient_holds: null, last_check_admin_holds: null, source_wallet: "0x38300125d58f76d1", ...over,
})
const d = (m: PoolRow, recipient = W, locked: boolean | null = false): DeliveredMoment => ({ recipient, m, locked })

describe("recordDeliveredInWalletCache", () => {
  it("a Moment the cache lacks gets a NAMED row stamped with the wallet's EXISTING newest last_seen_at, never now()", async () => {
    const f = fakeDb([
      { wallet_address: W, collection_id: COL, moment_id: "9", edition_key: "1:1", last_seen_at: "2026-11-09T05:00:00Z" },
      { wallet_address: W, collection_id: COL, moment_id: "8", edition_key: "1:1", last_seen_at: "2026-11-01T05:00:00Z" },
    ])
    const r = await recordDeliveredInWalletCache(f.db, COL, [d(pm("100"))])
    expect(r).toEqual({ written: 1, error: null })
    const row = f.rows.find((x) => x.moment_id === "100")!
    expect(row).toMatchObject({ edition_key: "26:559", player_name: "Damian Lillard", set_name: "Base Set", serial_number: 8381, collection_id: COL, is_locked: false })
    expect(row.last_seen_at).toBe("2026-11-09T05:00:00Z")
    expect(f.rpcs).toEqual([{ name: "backfill_wmc_metadata_from_editions", args: { p_wallet_address: W, p_collection_id: COL } }])
  })

  it("a bare stub (edition_key NULL) is named; a row a walk already named is left alone", async () => {
    const f = fakeDb([
      { wallet_address: W, collection_id: COL, moment_id: "100", edition_key: null, last_seen_at: "2026-11-10T01:19:37Z" },
      { wallet_address: W, collection_id: COL, moment_id: "200", edition_key: "9:9", set_name: "Walk's own", last_seen_at: "2026-11-10T01:19:37Z" },
    ])
    const r = await recordDeliveredInWalletCache(f.db, COL, [d(pm("100")), d(pm("200"))])
    expect(r.written).toBe(1)
    expect(f.rows.find((x) => x.moment_id === "100")).toMatchObject({ edition_key: "26:559", set_name: "Base Set" })
    expect(f.rows.find((x) => x.moment_id === "200")).toMatchObject({ edition_key: "9:9", set_name: "Walk's own" })
  })

  it("an empty cache takes now(); a Moment with no edition key and a non-Flow recipient are skipped", async () => {
    const f = fakeDb([])
    const r = await recordDeliveredInWalletCache(f.db, COL, [d(pm("100")), d(pm("101", { edition_key: null })), d(pm("102"), "GRWXtk2EYMvxN1P4NSorymJkPnEcHK63y95Ae6YqDymk")])
    expect(r.written).toBe(1)
    expect(f.rows.map((x) => x.moment_id)).toEqual(["100"])
    expect(Date.now() - Date.parse(String(f.rows[0].last_seen_at))).toBeLessThan(60_000)
  })

  it("every read and write is scoped by collection_id (#142)", async () => {
    const f = fakeDb([{ wallet_address: W, collection_id: "other", moment_id: "100", edition_key: null, last_seen_at: "2026-11-09T00:00:00Z" }])
    await recordDeliveredInWalletCache(f.db, COL, [d(pm("100"))])
    for (const c of f.calls) {
      if (c.op === "upsert") for (const r of c.payload as Row[]) expect(r.collection_id).toBe(COL)
      else expect(c.filters).toContainEqual(["eq", "collection_id", COL])
    }
    expect(f.calls.some((c) => c.op === "upsert")).toBe(true)
    expect(f.rows.find((x) => x.collection_id === "other")).toMatchObject({ edition_key: null })
  })

  it("a failed anchor read writes NOTHING new (never now() over a live cache) and says so", async () => {
    const f = fakeDb([{ wallet_address: W, collection_id: COL, moment_id: "9", edition_key: "1:1", last_seen_at: "2026-11-09T05:00:00Z" }], { anchor: "timeout" })
    const r = await recordDeliveredInWalletCache(f.db, COL, [d(pm("100"))])
    expect(r.written).toBe(0)
    expect(r.error).toMatch(/anchor read: timeout/)
    expect(f.rows.some((x) => x.moment_id === "100")).toBe(false)
  })

  it("never throws: a failed write is reported with its wallet, and the count is rows written", async () => {
    const f = fakeDb([], { insert: "boom" })
    const r = await recordDeliveredInWalletCache(f.db, COL, [d(pm("100"))])
    expect(r).toEqual({ written: 0, error: `${W}: insert: boom` })
    const g = fakeDb([], { existing: "nope" })
    expect(await recordDeliveredInWalletCache(g.db, COL, [d(pm("100"))])).toEqual({ written: 0, error: `${W}: existing read: nope` })
  })
})
