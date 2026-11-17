// The two reads behind /admin/flowty-errors, extracted out of its `page.tsx`.
//
// ⚠ WHY AN ADMIN PAGE WAS WORTH THE SAME TREATMENT AS A PUBLIC ONE. It is
// `force-dynamic`, so every visit performs both RPCs inline with no Suspense
// boundary and no ISR entry to hide behind — and a read that is merely SLOW
// errors nowhere, so the console hung on a streaming shell rather than reaching
// the `loadError` branch it already had.
//
// ⚠ AND THE READER IS THE PERSON DEBUGGING THE OUTAGE. A triage console that
// hangs during saturation is unavailable exactly when it is needed, which is a
// worse failure than a public page rendering a degraded notice.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { loadErrorTriage } from "@/lib/admin/error-triage"

type Dash = { total?: number }
type Row = { status: string }

const okDb = (dash: unknown, sum: unknown) => ({
  rpc: async (fn: string) =>
    fn === "get_error_triage_dashboard"
      ? { data: dash, error: null }
      : { data: sum, error: null },
})
const errDb = (which: string, message: string) => ({
  rpc: async (fn: string) =>
    fn === which ? { data: null, error: { message } } : { data: null, error: null },
})
const hangDb = () => ({ rpc: () => new Promise(() => {}) })

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("loadErrorTriage", () => {
  it("a hung read reports its OWN sentence, not a driver message", async () => {
    const res = await loadErrorTriage<Dash, Row>(hangDb(), 500)

    expect(res.dashboard).toBeNull()
    expect(res.summary).toEqual([])
    // ⚠ The distinction the operator actually needs: "Postgres answered with an
    // error" and "Postgres never answered" are different investigations, and only
    // one of them is a query bug. Asserting merely that SOME error came back
    // would pass on a fabricated driver string.
    expect(res.error).toContain("did not answer")
    expect(res.error).not.toContain("statement timeout")
  })

  it("a driver error is passed through verbatim — this is a gated operator console", async () => {
    // ⚠ Deliberate, and the opposite of the rule for public API handlers: the raw
    // message is the point of this screen, and /admin/* is reachable only with
    // RPC_ADMIN_TOKEN. `check-driver-message-leaks` exempts gated operator sites
    // for exactly this reason.
    const res = await loadErrorTriage<Dash, Row>(
      errDb("get_error_triage_dashboard", "canceling statement due to statement timeout"),
      500,
    )

    expect(res.error).toBe("canceling statement due to statement timeout")
  })

  it("the FIRST error wins when both reads fail", async () => {
    // The console shows one banner; overwriting it would hide whichever failure
    // came first. Matches the behaviour the page had before extraction.
    const db = { rpc: async (fn: string) => ({ data: null, error: { message: `${fn} failed` } }) }
    const res = await loadErrorTriage<Dash, Row>(db, 500)

    expect(res.error).toBe("get_error_triage_dashboard failed")
  })

  it("CONTROL — a successful read returns both payloads and NO error", async () => {
    const res = await loadErrorTriage<Dash, Row>(okDb({ total: 7 }, [{ status: "open" }]), 500)

    expect(res.error).toBeNull()
    expect(res.dashboard).toEqual({ total: 7 })
    expect(res.summary).toEqual([{ status: "open" }])
  })

  it("CONTROL — the dashboard RPC's single-row-array shape is unwrapped", async () => {
    // ⚠ Pinned because the page's own comment says the RPC may answer either way,
    // and the unwrap moved during extraction. A wrong shape here renders an empty
    // console against a healthy database.
    const res = await loadErrorTriage<Dash, Row>(okDb([{ total: 3 }], []), 500)

    expect(res.dashboard).toEqual({ total: 3 })
  })

  it("CONTROL — a genuinely empty triage queue is not an error", async () => {
    // The state the bound must not swallow: nothing to triage is good news.
    const res = await loadErrorTriage<Dash, Row>(okDb(null, []), 500)

    expect(res).toEqual({ dashboard: null, summary: [], error: null })
  })
})
