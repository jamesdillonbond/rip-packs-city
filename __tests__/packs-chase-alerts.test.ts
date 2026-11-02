import { describe, it, expect } from "vitest"
import { decideChaseWatch, readingFor, runPackChaseDispatch, ptDay } from "@/lib/packs/chase-alerts"

// Pack-chase watches (lib/packs/chase-alerts.ts). Pins: edge-trigger (fire once,
// re-arm only on a VALID false reading); an unknown reading neither fires nor re-arms;
// enqueue BEFORE disarm (a failed enqueue stays armed); no channel stays armed; a
// failed reading read holds everything.

const NOW = Date.parse("2026-11-02T16:00:00Z")
const atlas = (over: Record<string, unknown> = {}) => ({
  dist_id: "8903", title: "Rookie Year Royalty Pack", summary_fetched_at: "2026-11-02T10:00:00Z",
  unopened_count: 18, total_pack_count: 719,
  // every tier, as Dapper sends it (3 moments/pack now and at launch: self-consistent)
  remaining_by_tier: { legendary: "1", common: "53" }, original_by_tier: { legendary: "3", common: "2154" }, ...over,
})

describe("decideChaseWatch", () => {
  const r = readingFor(atlas(), 600, "legendary", NOW)!
  it("fires once when armed and met; holds when already fired", () => {
    expect(decideChaseWatch({ armed: true, min_vs_launch: 10 }, r)).toBe("fire")
    expect(decideChaseWatch({ armed: false, min_vs_launch: 10 }, r)).toBe("hold")
  })
  it("re-arms only on a valid reading below the threshold", () => {
    expect(decideChaseWatch({ armed: false, min_vs_launch: 20 }, r)).toBe("rearm")
    expect(decideChaseWatch({ armed: false, min_vs_launch: 20 }, null)).toBe("hold")
  })
  it("an unknown reading never fires", () => {
    expect(decideChaseWatch({ armed: true, min_vs_launch: 1 }, null)).toBe("hold")
  })
})

describe("readingFor", () => {
  it("is null when stale, refuted, or absent", () => {
    expect(readingFor(atlas({ summary_fetched_at: "2026-10-01T00:00:00Z" }), 0, "legendary", NOW)).toBeNull()
    expect(readingFor(atlas(), 702, "legendary", NOW)).toBeNull() // 701 opened < 702 observed
    expect(readingFor(undefined, 0, "legendary", NOW)).toBeNull()
  })
  it("a sold-out tier is a valid reading of 0 (so a fired watch can re-arm)", () => {
    const r = readingFor(atlas({ remaining_by_tier: { legendary: "0", common: "54" } }), 0, "legendary", NOW)!
    expect(r.remaining).toBe(0)
    expect(decideChaseWatch({ armed: false, min_vs_launch: 2 }, r)).toBe("rearm")
  })
})

it("ptDay is the Pacific calendar day", () => {
  expect(ptDay(Date.parse("2026-11-02T06:00:00Z"))).toBe("2026-11-01")
})

// ── runPackChaseDispatch with a recording fake db ──
function fakeDb(opts: { watches: any[]; atlasRows?: any[]; readErr?: boolean; insertErr?: boolean }) {
  const log: string[] = []
  const from = (table: string) => {
    let op = "select"
    let payload: any = null
    const b: any = {
      select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b,
      update: (p: any) => { op = "update"; payload = p; return b },
      upsert: (rows: any) => { op = "upsert"; payload = rows; return b },
      then: (resolve: any) => {
        if (table === "pack_chase_watches" && op === "select") return resolve({ data: opts.watches, error: null })
        if (table === "pack_chase_watches" && op === "update") { log.push(`update armed=${payload.armed}`); return resolve({ data: null, error: null }) }
        if (table === "topshot_atlas_dists") return resolve(opts.readErr ? { data: null, error: { message: "boom" } } : { data: opts.atlasRows ?? [atlas()], error: null })
        if (table === "pack_table_rows") return resolve({ data: [{ dist_id: "8903", observed_packs_opened: 600 }], error: null })
        if (table === "alert_deliveries") {
          log.push(`enqueue ${payload.length} kind=${payload[0].alert_kind} bucket=${payload[0].dedup_bucket}`)
          return resolve(opts.insertErr ? { data: null, error: { message: "insert failed" } } : { data: payload.map((_: any, i: number) => ({ id: String(i) })), error: null })
        }
        return resolve({ data: [], error: null })
      },
    }
    return b
  }
  return { db: { from }, log }
}
const watch = (over: Record<string, unknown> = {}) => ({ id: "w1", owner_key: "u1", dist_id: "8903", title: null, tier: "legendary", min_vs_launch: 10, armed: true, ...over })
const targets = async () => [{ channel: "email", channel_user_id: "a@b.c" }, { channel: "telegram", channel_user_id: "42" }]

describe("runPackChaseDispatch", () => {
  it("enqueues to every linked channel, THEN disarms", async () => {
    const { db, log } = fakeDb({ watches: [watch()] })
    const r = await runPackChaseDispatch(db, targets, NOW)
    expect(log).toEqual(["enqueue 2 kind=pack_digest bucket=w1:2026-11-02", "update armed=false"])
    expect(r).toMatchObject({ watches_scanned: 1, fired: 1, deliveries_written: 2, enqueue_error: null })
  })
  it("a failed enqueue stays armed and reports the error", async () => {
    const { db, log } = fakeDb({ watches: [watch()], insertErr: true })
    const r = await runPackChaseDispatch(db, targets, NOW)
    expect(log.some((l) => l.startsWith("update"))).toBe(false)
    expect(r).toMatchObject({ fired: 0, deliveries_written: 0, enqueue_error: "insert failed" })
  })
  it("no linked channel: stays armed, counted", async () => {
    const { db, log } = fakeDb({ watches: [watch()] })
    const r = await runPackChaseDispatch(db, async () => [], NOW)
    expect(log).toEqual([])
    expect(r).toMatchObject({ fired: 0, no_channel: 1 })
  })
  it("a failed reading read holds every watch — never fires, never re-arms", async () => {
    const { db, log } = fakeDb({ watches: [watch(), watch({ id: "w2", armed: false, min_vs_launch: 50 })], readErr: true })
    const r = await runPackChaseDispatch(db, targets, NOW)
    expect(log).toEqual([])
    expect(r.unknown).toBe(2)
    expect(r.state_error).toContain("boom")
  })
  it("re-arms a fired watch whose condition is now false", async () => {
    const { db, log } = fakeDb({ watches: [watch({ armed: false, min_vs_launch: 50 })] })
    const r = await runPackChaseDispatch(db, targets, NOW)
    expect(log).toEqual(["update armed=true"])
    expect(r.rearmed).toBe(1)
  })
})
