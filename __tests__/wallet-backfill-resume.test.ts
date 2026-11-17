import { describe, it, expect } from "vitest"
import { drainResumeQueue, enqueueResume, MAX_RESUME_ATTEMPTS, RESUME_MIN_AGE_MS } from "@/lib/chains/flow/wallet-backfill-resume"
import type { ContinuationDispatch } from "@/lib/chains/flow/wallet-backfill-continuation"

// #245 (2026-11-10): Vercel answered a walk's self-dispatch with HTTP 508 (a function→function chain
// too deep) and the walk stopped. A refused continuation is queued; a Vercel Cron route drains it from
// a fresh request. These pin the drain's contract: dispatch at the SAME depth, delete only what was
// dispatched, requeue a repeat failure, drop after MAX_RESUME_ATTEMPTS, and an `ok` that is derived.

type Row = { wallet: string; depth: number; attempts: number; queued_at: string; last_error?: string | null }

function fakeDb(rows: Row[], fail: { read?: boolean; del?: boolean; upd?: boolean } = {}) {
  const state = { rows: [...rows], upserts: [] as unknown[] }
  const db = {
    from() {
      const q: Record<string, unknown> = {}
      let cut = ""
      let lim = 1000
      const sel = {
        lt(_c: string, v: string) { cut = v; return sel },
        order() { return sel },
        limit(n: number) {
          lim = n
          if (fail.read) return Promise.resolve({ data: null, error: { message: "read boom" } })
          const data = state.rows.filter((r) => r.queued_at < cut).sort((a, b) => a.queued_at.localeCompare(b.queued_at)).slice(0, lim)
          return Promise.resolve({ data, error: null })
        },
      }
      q.select = () => sel
      q.delete = () => ({ eq: (_c: string, w: string) => {
        if (fail.del) return Promise.resolve({ error: { message: "del boom" } })
        state.rows = state.rows.filter((r) => r.wallet !== w); return Promise.resolve({ error: null })
      } })
      q.update = (patch: Partial<Row>) => ({ eq: (_c: string, w: string) => {
        if (fail.upd) return Promise.resolve({ error: { message: "upd boom" } })
        state.rows = state.rows.map((r) => (r.wallet === w ? { ...r, ...patch } : r)); return Promise.resolve({ error: null })
      } })
      q.upsert = (row: Row) => { state.upserts.push(row); return Promise.resolve({ error: null }) }
      return q
    },
  }
  return { db, state }
}

const NOW = Date.parse("2026-11-10T18:00:00Z")
const old = new Date(NOW - RESUME_MIN_AGE_MS - 1000).toISOString()
const fresh = new Date(NOW - 5_000).toISOString()
const okD = (depth: number): ContinuationDispatch => ({ ok: true, depth, attempts: 1, status: 202, error: null })
const failD = (depth: number): ContinuationDispatch => ({ ok: false, depth, attempts: 2, status: 508, error: "HTTP 508" })

describe("wallet-backfill resume queue (#245)", () => {
  it("dispatches each queued wallet at its SAME depth and deletes it once dispatched", async () => {
    const { db, state } = fakeDb([{ wallet: "0xa", depth: 3, attempts: 0, queued_at: old }])
    const calls: Array<[string, number]> = []
    const r = await drainResumeQueue(db, "https://x/api/cron/wallet-backfill-resume", { nowMs: NOW, dispatch: async (_u, w, d) => { calls.push([w, d]); return okD(d) } })
    expect(calls).toEqual([["0xa", 3]])
    expect(r).toMatchObject({ ok: true, picked: 1, dispatched: 1, requeued: 0 })
    expect(state.rows).toEqual([])
  })

  it("leaves a row younger than the minimum age for the walk that queued it", async () => {
    const { db } = fakeDb([{ wallet: "0xa", depth: 3, attempts: 0, queued_at: fresh }])
    const r = await drainResumeQueue(db, "https://x/", { nowMs: NOW, dispatch: async (_u, _w, d) => okD(d) })
    expect(r).toMatchObject({ ok: true, picked: 0, dispatched: 0 })
  })

  it("a repeat failure is requeued with attempts + 1 and makes the run NOT ok", async () => {
    const { db, state } = fakeDb([{ wallet: "0xa", depth: 3, attempts: 1, queued_at: old }])
    const r = await drainResumeQueue(db, "https://x/", { nowMs: NOW, dispatch: async (_u, _w, d) => failD(d) })
    expect(r).toMatchObject({ ok: false, dispatched: 0, requeued: 1 })
    expect(state.rows[0]).toMatchObject({ wallet: "0xa", attempts: 2, last_error: "HTTP 508" })
  })

  it("after MAX_RESUME_ATTEMPTS the row is dropped and named, never retried forever", async () => {
    const { db, state } = fakeDb([{ wallet: "0xa", depth: 3, attempts: MAX_RESUME_ATTEMPTS - 1, queued_at: old }])
    const r = await drainResumeQueue(db, "https://x/", { nowMs: NOW, dispatch: async (_u, _w, d) => failD(d) })
    expect(r.ok).toBe(false)
    expect(r.dropped).toEqual([{ wallet: "0xa", depth: 3, error: "HTTP 508" }])
    expect(state.rows).toEqual([])
  })

  it("a failed delete after a good dispatch is an error, not a count", async () => {
    const { db } = fakeDb([{ wallet: "0xa", depth: 3, attempts: 0, queued_at: old }], { del: true })
    const r = await drainResumeQueue(db, "https://x/", { nowMs: NOW, dispatch: async (_u, _w, d) => okD(d) })
    expect(r.ok).toBe(false)
    expect(r.dispatched).toBe(0)
    expect(r.errors[0]).toMatch(/delete 0xa: del boom/)
  })

  it("a failed queue read is not ok and dispatches nothing (never an empty-queue success)", async () => {
    const { db } = fakeDb([], { read: true })
    let n = 0
    const r = await drainResumeQueue(db, "https://x/", { nowMs: NOW, dispatch: async (_u, _w, d) => { n++; return okD(d) } })
    expect(r.ok).toBe(false)
    expect(r.errors).toEqual(["read: read boom"])
    expect(n).toBe(0)
  })

  it("an empty queue is a clean run", async () => {
    const { db } = fakeDb([])
    const r = await drainResumeQueue(db, "https://x/", { nowMs: NOW, dispatch: async (_u, _w, d) => okD(d) })
    expect(r).toMatchObject({ ok: true, picked: 0 })
  })

  it("enqueueResume writes one row per wallet at the refused depth", async () => {
    const { db, state } = fakeDb([])
    const q = await enqueueResume(db, "0xa", 3, "HTTP 508", "2026-11-10T18:00:00.000Z")
    expect(q).toEqual({ ok: true, error: null })
    expect(state.upserts).toEqual([{ wallet: "0xa", depth: 3, queued_at: "2026-11-10T18:00:00.000Z", attempts: 0, last_error: "HTTP 508", last_attempt_at: null }])
  })
})
