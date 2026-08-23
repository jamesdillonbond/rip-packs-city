import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Tests for lib/moment-detail/fetchers.ts — the data layer extracted out of
// app/moment/[id]/page.tsx (1,979 lines, 9 inline fetchers, measured by neither
// coverage gate) on 2026-08-13.
//
// The assertion that matters most in this file is that a FAILED read never
// becomes a 404. `/moment/[id]` is the platform's most-shared URL — every moment
// link posted into Discord, Twitter or a DM lands here — and `fetchDetail`
// returned a bare `null` for both "no such moment" and "the RPC failed", with
// the page answering `notFound()`. A statement timeout therefore told a collector
// who had just shared the link that their moment does not exist, and handed a
// crawler a hard 404 for a real page.
//
// ⚠ The subtlety this suite exists to lock down is the TWO `ok`s. The RPC's
// payload carries its own `ok`, meaning "I looked and there is no such moment" —
// an ANSWER, which must still 404. The envelope's `ok` means "the read itself
// worked". Merging them re-creates the exact defect, so several cases below
// assert them moving independently.

import {
  fetchMomentDetail,
  fetchHighOffer,
  fetchMomentBestOffer,
  fetchParallels,
  fetchSubeditionSiblings,
  fetchBadges,
  fetchSpecialSerialsForSerial,
  fetchEditionNotableSerials,
  fetchActiveListingAsk,
} from "@/lib/moment-detail/fetchers"

type Payload = { data?: unknown; error?: unknown }

function makeDb(fixtures: Record<string, Payload>) {
  const calls: string[] = []
  const get = (key: string): Payload => {
    calls.push(key)
    return fixtures[key] ?? { data: null, error: null }
  }
  const builder = (key: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "is", "order", "limit"]) b[m] = () => b
    b.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(get(key)).then(onF, onR)
    return b
  }
  return {
    db: {
      from: (table: string) => builder(table),
      rpc: async (name: string) => get(`rpc:${name}`),
    },
    calls,
  }
}

/** A client whose every call throws — the non-Postgrest failure path. */
const throwingDb = {
  from: () => {
    throw new Error("socket hang up")
  },
  rpc: async () => {
    throw new Error("socket hang up")
  },
}

const DB_ERR = { message: "canceling statement due to statement timeout" }

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ── The gate ────────────────────────────────────────────────────────────────

describe("fetchMomentDetail keeps the transport ok separate from the RPC's verdict", () => {
  it("a successful read of a real moment is ok:true with the payload", async () => {
    const { db } = makeDb({
      "rpc:get_moment_detail": { data: { ok: true, edition: { id: "e1" } }, error: null },
    })
    const res = await fetchMomentDetail("abc", db)
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ ok: true })
  })

  it("the RPC saying 'no such moment' is an ANSWER — ok:true, payload.ok:false", async () => {
    // This is the case that must still 404. If the envelope reported ok:false
    // here, every genuinely-missing moment would render the unavailable card
    // instead of a 404 — the mirror-image defect, and just as wrong.
    const { db } = makeDb({ "rpc:get_moment_detail": { data: { ok: false }, error: null } })
    const res = await fetchMomentDetail("nope", db)
    expect(res.ok).toBe(true)
    expect((res.data as { ok?: boolean } | null)?.ok).toBe(false)
  })

  it("an RPC ERROR is ok:false — the caller must not 404 on it", async () => {
    const { db } = makeDb({ "rpc:get_moment_detail": { data: null, error: DB_ERR } })
    expect(await fetchMomentDetail("timeout-case", db)).toEqual({ data: null, ok: false })
  })

  it("a thrown client is ok:false too", async () => {
    expect(await fetchMomentDetail("throw-case", throwingDb)).toEqual({ data: null, ok: false })
  })

  it("a null payload with no error is ok:true", async () => {
    const { db } = makeDb({ "rpc:get_moment_detail": { data: null, error: null } })
    expect(await fetchMomentDetail("null-case", db)).toEqual({ data: null, ok: true })
  })
})

// ── Auxiliary panels: uniform contract ──────────────────────────────────────

describe("every auxiliary fetcher separates a failed read from an empty one", () => {
  it.each([
    ["fetchParallels", "get_edition_parallels", (db: unknown) => fetchParallels("e1", db)],
    ["fetchBadges", "get_edition_badges_unified", (db: unknown) => fetchBadges("e1", db)],
    [
      "fetchEditionNotableSerials",
      "get_edition_special_serials",
      (db: unknown) => fetchEditionNotableSerials("e1", db),
    ],
    [
      "fetchSpecialSerialsForSerial",
      "get_edition_special_serials",
      (db: unknown) => fetchSpecialSerialsForSerial("e1", 7, db),
    ],
    [
      "fetchSubeditionSiblings",
      "get_edition_subedition_siblings",
      (db: unknown) => fetchSubeditionSiblings("1:2", db),
    ],
  ])("%s: error → ok:false", async (_name, rpc, run) => {
    const { db } = makeDb({ [`rpc:${rpc}`]: { data: null, error: DB_ERR } })
    const res = (await run(db)) as { rows: unknown[]; ok: boolean }
    expect(res).toEqual({ rows: [], ok: false })
  })

  it.each([
    ["fetchParallels", "get_edition_parallels", (db: unknown) => fetchParallels("e1", db)],
    ["fetchBadges", "get_edition_badges_unified", (db: unknown) => fetchBadges("e1", db)],
    [
      "fetchEditionNotableSerials",
      "get_edition_special_serials",
      (db: unknown) => fetchEditionNotableSerials("e1", db),
    ],
  ])("%s: a non-array payload degrades to [] WITHOUT claiming failure", async (_n, rpc, run) => {
    const { db } = makeDb({ [`rpc:${rpc}`]: { data: { unexpected: true }, error: null } })
    const res = (await run(db)) as { rows: unknown[]; ok: boolean }
    expect(res).toEqual({ rows: [], ok: true })
  })

  it.each([
    ["fetchParallels", (db: unknown) => fetchParallels("e1", db)],
    ["fetchBadges", (db: unknown) => fetchBadges("e1", db)],
    ["fetchHighOffer", (db: unknown) => fetchHighOffer("e1", db)],
    ["fetchMomentBestOffer", (db: unknown) => fetchMomentBestOffer("e1", 1, db)],
    ["fetchEditionNotableSerials", (db: unknown) => fetchEditionNotableSerials("e1", db)],
    ["fetchSpecialSerialsForSerial", (db: unknown) => fetchSpecialSerialsForSerial("e1", 1, db)],
    ["fetchSubeditionSiblings", (db: unknown) => fetchSubeditionSiblings("1:2", db)],
  ])("%s: a thrown client is ok:false", async (_name, run) => {
    const res = (await run(throwingDb)) as { ok: boolean }
    expect(res.ok).toBe(false)
  })
})

// ── Offer shapes ────────────────────────────────────────────────────────────

describe("offer fetchers accept both PostgREST return shapes", () => {
  it("fetchHighOffer unwraps a one-element array", async () => {
    const { db } = makeDb({
      "rpc:get_edition_high_offer": { data: [{ highest_offer: 12, low_ask: 20 }], error: null },
    })
    const res = await fetchHighOffer("e1", db)
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ highest_offer: 12 })
  })

  it("fetchHighOffer accepts a bare object", async () => {
    const { db } = makeDb({
      "rpc:get_edition_high_offer": { data: { highest_offer: 9 }, error: null },
    })
    expect((await fetchHighOffer("e1", db)).data).toMatchObject({ highest_offer: 9 })
  })

  it("an empty array is an absence, not a failure", async () => {
    const { db } = makeDb({ "rpc:get_edition_high_offer": { data: [], error: null } })
    expect(await fetchHighOffer("e1", db)).toEqual({ data: null, ok: true })
  })

  it("fetchMomentBestOffer errors as ok:false", async () => {
    const { db } = makeDb({ "rpc:get_moment_best_offer": { data: null, error: DB_ERR } })
    expect(await fetchMomentBestOffer("e1", 3, db)).toEqual({ data: null, ok: false })
  })

  it("fetchMomentBestOffer passes the serial through", async () => {
    // Serial-grain is the whole point of this RPC vs the edition-grain one; a
    // call that dropped the serial would silently answer the wrong question.
    const seen: Record<string, unknown>[] = []
    const db = {
      rpc: async (_n: string, args: Record<string, unknown>) => {
        seen.push(args)
        return { data: { best_offer: 5 }, error: null }
      },
    }
    await fetchMomentBestOffer("e1", 42, db)
    expect(seen[0]).toMatchObject({ p_edition_id: "e1", p_serial: 42 })
  })
})

// ── Subedition coercion ─────────────────────────────────────────────────────

describe("fetchSubeditionSiblings coerces fmv_usd", () => {
  it("turns the numeric STRING PostgREST returns into a number", async () => {
    // Left as a string, the premium math concatenates instead of adding — a
    // wrong number rendered with total confidence.
    const { db } = makeDb({
      "rpc:get_edition_subedition_siblings": {
        data: [{ external_id: "1:2", fmv_usd: "12.50", is_self: true }],
        error: null,
      },
    })
    const res = await fetchSubeditionSiblings("1:2", db)
    expect(res.ok).toBe(true)
    expect(res.rows[0].fmv_usd).toBe(12.5)
    expect(typeof res.rows[0].fmv_usd).toBe("number")
  })

  it("leaves a null fmv_usd null rather than coercing it to 0", async () => {
    // Number(null) is 0, which would price an unpriced parallel at zero.
    const { db } = makeDb({
      "rpc:get_edition_subedition_siblings": {
        data: [{ external_id: "1:2", fmv_usd: null, is_self: false }],
        error: null,
      },
    })
    expect((await fetchSubeditionSiblings("1:2", db)).rows[0].fmv_usd).toBeNull()
  })
})

// ── The live ask, and its deliberate refusal ────────────────────────────────

describe("fetchActiveListingAsk", () => {
  it("returns the cheapest active ask", async () => {
    const { db } = makeDb({ cached_listings_v2: { data: [{ price_usd: 31.5 }], error: null } })
    expect(await fetchActiveListingAsk("123", "coll-1", db)).toEqual({ data: 31.5, ok: true })
  })

  it("treats a zero or negative price as no ask", async () => {
    const { db } = makeDb({ cached_listings_v2: { data: [{ price_usd: 0 }], error: null } })
    expect(await fetchActiveListingAsk("123", "coll-1", db)).toEqual({ data: null, ok: true })
  })

  it("no active row is an absence", async () => {
    const { db } = makeDb({ cached_listings_v2: { data: [], error: null } })
    expect(await fetchActiveListingAsk("123", "coll-1", db)).toEqual({ data: null, ok: true })
  })

  it("a query error is ok:false", async () => {
    const { db } = makeDb({ cached_listings_v2: { data: null, error: DB_ERR } })
    expect(await fetchActiveListingAsk("123", "coll-1", db)).toEqual({ data: null, ok: false })
  })

  // ⚠ The refusal cases. These are ok:TRUE — we chose not to answer, which is a
  // different thing from failing to, and marking them degraded would put a
  // notice on every Top Shot moment page (Top Shot has no rows in this table).
  it("REFUSES without a collection scope, and reports that as ok:true", async () => {
    // Flow nft_ids are unique only per contract, so flow_id alone collides
    // across collections — the 2026-07-03 QA finding where a Top Shot moment
    // rendered an All Day listing's price.
    const { db, calls } = makeDb({ cached_listings_v2: { data: [{ price_usd: 99 }], error: null } })
    expect(await fetchActiveListingAsk("123", null, db)).toEqual({ data: null, ok: true })
    expect(calls, "must not query at all without the scope").toEqual([])
  })

  it("refuses a non-numeric nft_id without querying", async () => {
    const { db, calls } = makeDb({ cached_listings_v2: { data: [{ price_usd: 99 }], error: null } })
    expect(await fetchActiveListingAsk("not-a-number", "coll-1", db)).toEqual({ data: null, ok: true })
    expect(calls).toEqual([])
  })

  it("scopes the query to the collection when it does run", async () => {
    const eqs: Array<[string, unknown]> = []
    const b: Record<string, unknown> = {}
    for (const m of ["select", "is", "order", "limit"]) b[m] = () => b
    b.eq = (col: string, val: unknown) => {
      eqs.push([col, val])
      return b
    }
    b.then = (onF?: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onF)
    await fetchActiveListingAsk("123", "coll-1", { from: () => b })
    expect(eqs).toEqual([
      ["flow_id", 123],
      ["collection_id", "coll-1"],
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDS — a read that HANGS must reach the same `ok: false` these fetchers
// already return for an error.
//
// ⚠ The distinction between "the query failed" and "the answer is empty" was
// already the whole point of this module (see its header). What none of it could
// reach was the failure DB saturation actually produces: **a read that is merely
// SLOW errors nowhere.** supabase-js resolves `{ data, error }` only when the
// query finishes, so `/moment/[id]` waited on a streaming shell that Vercel logs
// as a 200 — the "200-but-broken-DOM" shape in its latency form.
//
// ⚠ Two fetchers are asserted rather than all nine, and that is a deliberate
// choice worth stating: they share ONE `bounded()` helper, so nine near-identical
// assertions would test the helper nine times while reading as nine units of
// coverage. What is NOT shared — that each call site's `catch` returns the right
// SHAPE (`{ data: null }` vs `{ rows: [] }`) — is why one of each is asserted.
// ─────────────────────────────────────────────────────────────────────────────

/** A client whose rpc never settles. */
const hangingDb = { rpc: () => new Promise<never>(() => {}) }

describe("bounds — a hung read is a failed read", () => {
  it("fetchHighOffer resolves ok:false rather than hanging", async () => {
    const res = await fetchHighOffer("edition-1", hangingDb)

    expect(res.ok, "an overrun read must report FAILURE").toBe(false)
    expect(res.data).toBeNull()
    // ⚠ The absence of the false claim, not just the presence of a flag:
    // `{ data: null, ok: true }` means "asked, and there is no offer", which the
    // page is entitled to render as a fact.
    expect(res.data === null && res.ok === true).toBe(false)
  }, 20_000)

  it("fetchParallels resolves ok:false rather than hanging — and in the ROWS shape", async () => {
    const res = await fetchParallels("edition-1", hangingDb)

    expect(res.ok).toBe(false)
    expect(res.rows).toEqual([])
    expect(res.rows.length === 0 && res.ok === true, "must not read as 'no parallels'").toBe(false)
  }, 20_000)

  it("CONTROL — a read inside the budget still resolves normally", async () => {
    // Without this, a helper that rejected unconditionally would satisfy both
    // assertions above and this block would report coverage for a dead module.
    const fastDb = { rpc: async () => ({ data: [{ edition_id: "e2" }], error: null }) }
    const res = await fetchParallels("edition-1", fastDb)

    expect(res.ok).toBe(true)
    expect(res.rows).toHaveLength(1)
  })

  it("CONTROL — a genuinely empty answer is still ok:true", async () => {
    // The branch the bound must not swallow.
    const emptyDb = { rpc: async () => ({ data: [], error: null }) }
    const res = await fetchParallels("edition-1", emptyDb)

    expect(res).toEqual({ rows: [], ok: true })
  })
})
