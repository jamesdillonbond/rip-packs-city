import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Regression coverage for checkHtmlContains in the smoke-test route.
//
// These pages (pack "Sales History", edition "Activity") flush the asserted
// section from a <Suspense> boundary AFTER the 200 shell headers. fetch()
// resolves on the headers, so a slow streamed-body read (res.text()) can blow
// the timeout budget mid-stream under DB contention. The historical bug:
// `.catch(() => "")` swallowed that mid-stream abort into "", so the probe
// hard-failed as "HTTP 200, <needle>=false" — a false page. The fix classifies
// a body-read timeout the same as a fetch timeout: retry once, then SOFT
// inconclusive; a body that fully reads but genuinely lacks the needle still
// HARD-fails. These tests pin both halves so the swallow can't come back.

import { checkHtmlContains, smokeFetchRetry } from "@/app/api/smoke-test/route"

const META = { name: "pack dist page has Sales History", endpoint: "/x", expected: "html-contains" }
const URL = "https://www.rippackscity.com/nba-top-shot/pack/dist/5048"
const NEEDLE = "Sales History"

// A timeout/abort-shaped error — checkHtmlContains treats /abort|timeout/i as
// transient (matching AbortSignal.timeout's real DOMException message).
const timeoutErr = () => new Error("The operation was aborted due to timeout")

// Build a Response-like stub. `body` may be a string (text() resolves) or a
// thrown-error factory (text() rejects — the streamed-body-timeout case).
function res(status: number, body: string | (() => never)): any {
  return {
    status,
    text: async () => {
      if (typeof body === "function") body()
      return body as string
    },
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("checkHtmlContains — streamed-body timeout classification", () => {
  it("passes when a 200 body fully reads and contains the needle", async () => {
    fetchMock.mockResolvedValueOnce(res(200, `<html>…${NEEDLE}…</html>`))
    const r = await checkHtmlContains(META, URL, NEEDLE, 1_000)
    expect(r.passed).toBe(true)
    expect(r.statusCode).toBe(200)
    expect(r.soft).toBeFalsy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("HARD-fails (not soft) when a 200 body fully reads but the needle is genuinely absent", async () => {
    fetchMock.mockResolvedValueOnce(res(200, `<html>shell only, section regressed</html>`))
    const r = await checkHtmlContains(META, URL, NEEDLE, 1_000)
    expect(r.passed).toBe(false)
    expect(r.soft).toBeFalsy() // a real module regression must still page
    expect(r.statusCode).toBe(200)
    expect(r.detail).toContain(`${NEEDLE}=false`)
  })

  it("SOFT-inconclusive (no hard page) when the streamed body read times out on both attempts", async () => {
    // Both attempts: headers arrive (200) but text() aborts mid-stream. This is
    // the exact false-fail the fix prevents — previously a hard 200/needle=false.
    fetchMock
      .mockResolvedValueOnce(res(200, () => { throw timeoutErr() }))
      .mockResolvedValueOnce(res(200, () => { throw timeoutErr() }))
    const r = await checkHtmlContains(META, URL, NEEDLE, 1_000)
    expect(r.passed).toBe(false)
    expect(r.soft).toBe(true)
    expect(r.notes?.inconclusive).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2) // fetch + one retry
  })

  it("recovers to a pass when the streamed body read times out once then succeeds on retry", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, () => { throw timeoutErr() }))
      .mockResolvedValueOnce(res(200, `<html>…${NEEDLE}…</html>`))
    const r = await checkHtmlContains(META, URL, NEEDLE, 1_000)
    expect(r.passed).toBe(true)
    expect(r.soft).toBeFalsy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("SOFT-inconclusive when the header fetch itself times out on both attempts", async () => {
    fetchMock
      .mockRejectedValueOnce(timeoutErr())
      .mockRejectedValueOnce(timeoutErr())
    const r = await checkHtmlContains(META, URL, NEEDLE, 1_000)
    expect(r.passed).toBe(false)
    expect(r.soft).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("HARD-fails on a genuine non-200 (real outage), body not asserted", async () => {
    fetchMock.mockResolvedValueOnce(res(500, "internal error"))
    const r = await checkHtmlContains(META, URL, NEEDLE, 1_000)
    expect(r.passed).toBe(false)
    expect(r.soft).toBeFalsy()
    expect(r.statusCode).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("smokeFetchRetry — one retry on the transient class", () => {
  it("returns the response on a first-attempt success (no retry)", async () => {
    fetchMock.mockResolvedValueOnce(res(200, "ok"))
    const r = await smokeFetchRetry(URL)
    expect(r.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("retries once and succeeds when the first attempt times out", async () => {
    fetchMock
      .mockRejectedValueOnce(timeoutErr())
      .mockResolvedValueOnce(res(200, "ok"))
    const r = await smokeFetchRetry(URL)
    expect(r.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("rethrows when both attempts fail transiently (caller records the soft fail)", async () => {
    fetchMock
      .mockRejectedValueOnce(timeoutErr())
      .mockRejectedValueOnce(timeoutErr())
    await expect(smokeFetchRetry(URL)).rejects.toThrow(/timeout/i)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does NOT retry a non-transient error (real contract breach surfaces immediately)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED hard failure"))
    await expect(smokeFetchRetry(URL)).rejects.toThrow(/ECONNREFUSED/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("retries with a FRESH signal when the caller's one-shot timeout signal already aborted", async () => {
    // The bug this pins: the caller passes `signal: AbortSignal.timeout(N)`,
    // which fires (aborts) during the first attempt. Reusing that same signal on
    // the retry makes the retry fetch abort instantly, so the retry never had a
    // chance — NEXTJS-K flapped 43× exactly this way. The retry must get a new,
    // non-aborted signal.
    const aborted = AbortSignal.abort() // already-aborted, like a fired timeout
    const seenSignals: (AbortSignal | undefined)[] = []
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      seenSignals.push(init?.signal ?? undefined)
      if (seenSignals.length === 1) return Promise.reject(timeoutErr())
      return Promise.resolve(res(200, "ok"))
    })

    const r = await smokeFetchRetry(URL, { signal: aborted })

    expect(r.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(seenSignals[0]).toBe(aborted) // first attempt honors the caller's signal
    expect(seenSignals[1]).toBeDefined()
    expect(seenSignals[1]).not.toBe(aborted) // retry got a fresh one
    expect(seenSignals[1]!.aborted).toBe(false) // …and it is live, not pre-aborted
  })

  it("reuses the caller's signal on retry when it has NOT aborted (non-timeout transient)", async () => {
    // A live signal (e.g. a network blip that isn't a timeout) still has budget
    // left, so the retry reuses it rather than resetting the clock.
    const live = AbortSignal.timeout(30_000)
    const seenSignals: (AbortSignal | undefined)[] = []
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      seenSignals.push(init?.signal ?? undefined)
      if (seenSignals.length === 1) return Promise.reject(new Error("fetch failed"))
      return Promise.resolve(res(200, "ok"))
    })

    const r = await smokeFetchRetry(URL, { signal: live })

    expect(r.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(seenSignals[0]).toBe(live)
    expect(seenSignals[1]).toBe(live) // not aborted → reused, no fresh signal
  })
})
