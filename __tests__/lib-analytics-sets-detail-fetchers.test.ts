import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import {
  loadSet,
  setDetailStaticParams,
  UUID_RE,
  SET_DETAIL_TIMEOUT_MS,
} from "@/lib/analytics/sets/detail-fetchers"

// The two reads behind /analytics/sets/[set_id], now that they live in lib/ and
// a gate can see them.
//
// These are worth more than most page fetchers: this is the code that fixed a
// PRODUCTION BUILD FAILURE and a soft-404 in one change (2026-08-13), and until
// the extraction it was pinned only by source assertions — a guard grepping the
// page for `return { data: null, ok: false }` proves the string is present, not
// that the branch is reachable or that the race resolves the way it claims.

const VALID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function db(impl: () => unknown) {
  return { rpc: () => impl() }
}

describe("UUID_RE", () => {
  it("accepts a canonical uuid and rejects the near-misses a crawler invents", () => {
    expect(UUID_RE.test(VALID)).toBe(true)
    for (const bad of ["", "not-a-uuid", VALID.slice(0, -1), `${VALID}x`, "1234"]) {
      expect(UUID_RE.test(bad), `${bad} must not pass`).toBe(false)
    }
  })
})

describe("loadSet — error is not absence", () => {
  it("a malformed id is an ANSWER (ok:true), not a failure", async () => {
    // ⚠ Deliberate. Flipping this to ok:false would put a permanent degraded
    // state on every bad URL a crawler invents, and the page would render
    // "unavailable" where "not found" is the truth.
    const res = await loadSet("nope", db(() => ({ data: null, error: null })))
    expect(res).toEqual({ data: null, ok: true })
  })

  it("does not even touch the database for a malformed id", async () => {
    const rpc = vi.fn()
    await loadSet("nope", { rpc })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("returns the payload on success", async () => {
    const payload = { set_id: VALID, name: "Base Set" }
    const res = await loadSet(VALID, db(() => ({ data: payload, error: null })))
    expect(res).toEqual({ data: payload, ok: true })
  })

  it("a 'not found' RPC error is an ANSWER — ok stays true", async () => {
    for (const msg of ["Set not found", "relation does not exist", "NOT FOUND"]) {
      const res = await loadSet(VALID, db(() => ({ data: null, error: { message: msg } })))
      expect(res, `${msg} should read as absence`).toEqual({ data: null, ok: true })
    }
  })

  it("any OTHER RPC error is a FAILURE — ok:false", async () => {
    // This is the whole defect: before `ok`, this case and the one above
    // returned the same bare null, and the page answered notFound() — telling a
    // visitor a real set does not exist, and baking that 404 at build time.
    const res = await loadSet(
      VALID,
      db(() => ({ data: null, error: { message: "canceling statement due to statement timeout" } })),
    )
    expect(res).toEqual({ data: null, ok: false })
  })

  it("a THROWN error is a failure, not an absence", async () => {
    const res = await loadSet(
      VALID,
      db(() => {
        throw new Error("connection terminated")
      }),
    )
    expect(res).toEqual({ data: null, ok: false })
  })

  it("null data with no error is an absent set, not a failure", async () => {
    const res = await loadSet(VALID, db(() => ({ data: null, error: null })))
    expect(res).toEqual({ data: null, ok: true })
  })

  it("NEVER throws — a throw here fails the BUILD, not just the request", async () => {
    await expect(
      loadSet(
        VALID,
        db(() => {
          throw new Error("boom")
        }),
      ),
    ).resolves.toBeDefined()
  })
})

describe("loadSet — the timeout race", () => {
  it("is bounded well under Next's 60s per-page export budget", () => {
    // A budget at or above that bound protects nothing: Next retries 3x and then
    // kills the whole build, which is exactly what happened on 2026-08-13.
    expect(SET_DETAIL_TIMEOUT_MS).toBeGreaterThan(0)
    expect(SET_DETAIL_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })

  it("a SLOW read resolves to the FAILED shape, not the absent one", async () => {
    // ⚠ The property a source grep cannot establish: that the race actually
    // resolves, and resolves to ok:false. A read that is merely slow is as
    // unservable as one that errored, and before this only the errored one was
    // modelled.
    vi.useFakeTimers()
    const pending = loadSet(VALID, db(() => new Promise(() => {})))
    await vi.advanceTimersByTimeAsync(SET_DETAIL_TIMEOUT_MS + 10)
    await expect(pending).resolves.toEqual({ data: null, ok: false })
  })

  it("a read that finishes inside the budget wins the race", async () => {
    vi.useFakeTimers()
    const payload = { set_id: VALID }
    const pending = loadSet(
      VALID,
      db(
        () =>
          new Promise((r) =>
            setTimeout(() => r({ data: payload, error: null }), SET_DETAIL_TIMEOUT_MS - 1_000),
          ),
      ),
    )
    await vi.advanceTimersByTimeAsync(SET_DETAIL_TIMEOUT_MS)
    await expect(pending).resolves.toEqual({ data: payload, ok: true })
  })

  it("an abandoned query failing LATER does not become an unhandled rejection", async () => {
    // The catch lives INSIDE the raced promise for this reason. If it did not,
    // a slow query that eventually rejects would surface after we stopped
    // listening and crash the render (or the build) well after the timeout
    // already degraded the page gracefully.
    vi.useFakeTimers()
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on("unhandledRejection", onUnhandled)
    try {
      const pending = loadSet(
        VALID,
        db(
          () =>
            new Promise((_res, rej) =>
              setTimeout(() => rej(new Error("late failure")), SET_DETAIL_TIMEOUT_MS + 500),
            ),
        ),
      )
      await vi.advanceTimersByTimeAsync(SET_DETAIL_TIMEOUT_MS + 10)
      await expect(pending).resolves.toEqual({ data: null, ok: false })
      await vi.advanceTimersByTimeAsync(1_000)
      await Promise.resolve()
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

describe("setDetailStaticParams — build-time prerender list", () => {
  it("returns the uuid params on success", async () => {
    const rows = [{ set_id: VALID }, { set_id: "00000000-0000-4000-8000-000000000001" }]
    const res = await setDetailStaticParams(db(() => ({ data: rows, error: null })))
    expect(res).toEqual([{ set_id: rows[0].set_id }, { set_id: rows[1].set_id }])
  })

  it("filters out non-uuid ids rather than prerendering a route that cannot resolve", async () => {
    const res = await setDetailStaticParams(
      db(() => ({ data: [{ set_id: VALID }, { set_id: "junk" }], error: null })),
    )
    expect(res).toEqual([{ set_id: VALID }])
  })

  // ⚠ The `if (error || !Array.isArray(data)) return []` early return is
  // DEFENCE IN DEPTH and its two arms are NOT separately assertable — the outer
  // try/catch absorbs both. Remove the `error` arm and the throw is caught;
  // remove the `!Array.isArray` arm and `data.filter` throws on a non-array,
  // which is also caught. Mutation-checked both ways: each survives, while
  // removing the OUTER CATCH is killed. So the catch is the load-bearing guard
  // and the early return is a faster path to the same answer. The test below
  // asserts the OBSERVABLE contract — always `[]`, never a throw — rather than
  // pretending to distinguish arms that produce identical results.
  it("returns [] — never throws — when the directory read fails", async () => {
    // ⚠ This one runs at BUILD time. A throw here fails `npm run build` and
    // sends the production deploy to ERROR; [] simply means every set falls
    // through to ISR, which dynamicParams already makes safe.
    for (const bad of [
      () => ({ data: null, error: { message: "timeout" } }),
      () => ({ data: "not an array", error: null }),
      () => {
        throw new Error("pool exhausted")
      },
    ]) {
      await expect(setDetailStaticParams(db(bad))).resolves.toEqual([])
    }
  })
})
