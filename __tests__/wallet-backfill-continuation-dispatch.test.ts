import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { dispatchContinuation } from "@/lib/chains/flow/wallet-backfill-continuation"

// #245 (2026-11-09): geds' continuation chain stopped after the 7:45 AM PT walk and nothing
// recorded why — the dispatch was `fetch(...).catch(() => {})`. The dispatch now retries once
// and RETURNS its outcome, so a broken chain names itself.

const URL_ = "https://www.rippackscity.com/api/wallet-backfill"
const noPause = async () => {}
let saved: string | undefined
beforeEach(() => { saved = process.env.INGEST_SECRET_TOKEN; process.env.INGEST_SECRET_TOKEN = "t" })
afterEach(() => { if (saved === undefined) delete process.env.INGEST_SECRET_TOKEN; else process.env.INGEST_SECRET_TOKEN = saved })

describe("wallet-backfill continuation dispatch", () => {
  it("a 202 is ok after one attempt, and posts the next depth with skip_cached", async () => {
    let body: unknown = null
    const f = (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response("{}", { status: 202 }) }) as unknown as typeof fetch
    const d = await dispatchContinuation(URL_, "0xabc", 5, f, noPause)
    expect(d).toMatchObject({ ok: true, depth: 5, attempts: 1, status: 202, error: null })
    expect(body).toEqual({ wallet: "0xabc", skip_cached: true, continuation: 5 })
  })

  it("a thrown first attempt is RETRIED and the retry's success is reported", async () => {
    let n = 0
    const f = (async () => { n++; if (n === 1) throw new TypeError("fetch failed"); return new Response("{}", { status: 202 }) }) as unknown as typeof fetch
    const d = await dispatchContinuation(URL_, "0xabc", 2, f, noPause)
    expect(n).toBe(2)
    expect(d).toMatchObject({ ok: true, attempts: 2, status: 202 })
  })

  it("two failures are reported as NOT ok with the last status — never swallowed", async () => {
    const f = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch
    const d = await dispatchContinuation(URL_, "0xabc", 3, f, noPause)
    expect(d).toMatchObject({ ok: false, attempts: 2, status: 503, error: "HTTP 503" })
  })

  it("a thrown last attempt reports the error and a null status", async () => {
    const f = (async () => { throw new TypeError("fetch failed") }) as unknown as typeof fetch
    const d = await dispatchContinuation(URL_, "0xabc", 3, f, noPause)
    expect(d.ok).toBe(false)
    expect(d.status).toBeNull()
    expect(d.error).toMatch(/fetch failed/)
  })

  it("a missing token is a reported failure, not a silent return", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const d = await dispatchContinuation(URL_, "0xabc", 1, (async () => new Response("{}", { status: 202 })) as unknown as typeof fetch, noPause)
    expect(d.ok).toBe(false)
    expect(d.error).toMatch(/INGEST_SECRET_TOKEN/)
  })
})
