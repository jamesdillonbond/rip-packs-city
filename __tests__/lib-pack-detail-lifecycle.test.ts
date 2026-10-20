// The two reads behind /[collection]/pack/[id], extracted out of its `page.tsx`.
//
// ⚠ The lifecycle read's `ok` contract already existed and its history is on the
// module: it used to collapse into a bare `null`, so a statement timeout rendered
// the NotFoundCard — telling a visitor a pack that exists does not, at HTTP 200,
// which is also a soft-404 offered to crawlers.
//
// 🚨 THE DIST PROBE SITTING ONE FUNCTION BELOW IT HAD THE SAME DEFECT AND WAS
// LEFT BEHIND. It returned a bare `false` on error, and the caller reads `false`
// as "not a distribution" and answers with the NotFoundCard. So the fix landed on
// one of two adjacent reads and the other kept publishing the same false claim —
// the "fix per PANEL, not per page" failure, at the granularity of two functions
// in one file.
//
// ⚠ And neither was reachable from a HANG in the first place: a read that is
// merely slow errors nowhere, so the page waited on a streaming shell.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fetchLifecycle, isKnownDistId } from "@/lib/pack-detail/lifecycle"

const rpcDb = (payload: { data?: unknown; error?: { message: string } | null }) => ({
  rpc: async () => ({ data: payload.data ?? null, error: payload.error ?? null }),
})
const hangRpcDb = () => ({ rpc: () => new Promise(() => {}) })

function tableDb(payload: { data?: unknown; error?: { message: string } | null }, hang = false) {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "limit"]) b[m] = () => b
  b.maybeSingle = () =>
    hang
      ? new Promise(() => {})
      : Promise.resolve({ data: payload.data ?? null, error: payload.error ?? null })
  return { from: () => b }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("fetchLifecycle", () => {
  it("a hung read reports ok:false — not a pack that does not exist", async () => {
    const res = await fetchLifecycle("42", hangRpcDb(), 500)

    expect(res.ok).toBe(false)
    // ⚠ The absence of the false claim: `{ lifecycle: null, ok: true }` is what
    // renders the NotFoundCard.
    expect(res.lifecycle === null && res.ok === true).toBe(false)
  })

  it("a driver error reports ok:false", async () => {
    const res = await fetchLifecycle("42", rpcDb({ error: { message: "boom" } }), 500)

    expect(res).toEqual({ lifecycle: null, ok: false })
  })

  it("CONTROL — a pack genuinely not in the index is ok:true", async () => {
    // The branch the bound must not swallow: most ids are not indexed packs.
    const res = await fetchLifecycle("42", rpcDb({ data: null }), 500)

    expect(res).toEqual({ lifecycle: null, ok: true })
  })

  it("CONTROL — a found pack comes back with ok:true", async () => {
    const res = await fetchLifecycle("42", rpcDb({ data: { status: "opened" } }), 500)

    expect(res.ok).toBe(true)
    expect(res.lifecycle).toEqual({ status: "opened" })
  })
})

describe("isKnownDistId", () => {
  it("a hung probe reports ok:false — not 'this is not a distribution'", async () => {
    const res = await isKnownDistId("c1", "dist-1", tableDb({}, true), 500)

    expect(res.ok).toBe(false)
    // ⚠ THE DEFECT THIS FUNCTION SHIPPED WITH. `{ known: false, ok: true }` is
    // what sends the page to NotFoundCard, so a probe we could not complete must
    // never resolve to it.
    expect(res.known === false && res.ok === true).toBe(false)
  })

  it("a driver error reports ok:false", async () => {
    const res = await isKnownDistId("c1", "dist-1", tableDb({ error: { message: "boom" } }), 500)

    expect(res).toEqual({ known: false, ok: false })
  })

  it("CONTROL — a candidate that is genuinely NOT a distribution is ok:true", async () => {
    // ⚠ The common path, and the one the fix must not break: most pack ids are
    // not dist ids. Turning that into an outage would put an Unavailable card in
    // front of every real not-found.
    const res = await isKnownDistId("c1", "not-a-dist", tableDb({ data: null }), 500)

    expect(res).toEqual({ known: false, ok: true })
  })

  it("CONTROL — a real distribution is known:true", async () => {
    const res = await isKnownDistId("c1", "dist-1", tableDb({ data: { dist_id: "dist-1" } }), 500)

    expect(res).toEqual({ known: true, ok: true })
  })
})

// ⛔ PACK NFT IDS ARE PER-CONTRACT (2026-10-19): 2,294 Golazos pack ids are also
// the ids of DIFFERENT All Day rips, and get_pack_lifecycle is keyed on the id
// alone. A collection-scoped read must reach that collection's own RPC and must
// never answer with a pack filed under another collection.
describe("fetchLifecycle is scoped to the collection asked about", () => {
  const GZ = "06248cc4-b85f-47cd-af67-1855d14acd75"
  const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
  const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
  const spyDb = (data: unknown) => {
    const calls: string[] = []
    return { calls, db: { rpc: async (name: string) => { calls.push(name); return { data, error: null } } } }
  }

  it("Golazos reads get_golazos_pack_lifecycle, not the Flow-table RPC", async () => {
    const { calls, db } = spyDb({ collection_id: GZ, status: "ripped" })
    const res = await fetchLifecycle("1", db, 500, GZ)
    expect(calls).toEqual(["get_golazos_pack_lifecycle"])
    expect(res).toEqual({ lifecycle: { collection_id: GZ, status: "ripped" }, ok: true })
  })

  it("a payload filed under ANOTHER collection is not this collection's pack", async () => {
    const { calls, db } = spyDb({ collection_id: AD, status: "ripped" })
    const res = await fetchLifecycle("1", db, 500, TS)
    expect(calls).toEqual(["get_pack_lifecycle"])
    expect(res).toEqual({ lifecycle: null, ok: true })
    expect(res.lifecycle).not.toMatchObject({ collection_id: AD })
  })

  it("the matching collection's payload passes through", async () => {
    const { db } = spyDb({ collection_id: AD, status: "sealed" })
    expect((await fetchLifecycle("1", db, 500, AD)).lifecycle).toEqual({ collection_id: AD, status: "sealed" })
  })

  it("unscoped (no collection) keeps the historical read", async () => {
    const { calls, db } = spyDb({ collection_id: AD, status: "sealed" })
    expect((await fetchLifecycle("1", db, 500)).lifecycle).toEqual({ collection_id: AD, status: "sealed" })
    expect(calls).toEqual(["get_pack_lifecycle"])
  })
})
