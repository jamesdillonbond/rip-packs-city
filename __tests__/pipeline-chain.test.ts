import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"

// fireNextPipelineStep schedules an authenticated POST to the next pipeline step
// via next/server after(). We stub after() to run its callback immediately so the
// fetch is observable, and cover: chain flag off, missing token, VERCEL_URL vs
// default base, query-string separator, and the fetch success + error paths.

// Capture after()'s callback and invoke it synchronously.
const afterCbs: Array<() => any> = []
vi.mock("next/server", () => ({
  after: (cb: () => any) => { afterCbs.push(cb) },
}))

import { fireNextPipelineStep } from "@/lib/pipeline-chain"

const origEnv = { ...process.env }

beforeEach(() => {
  afterCbs.length = 0
  process.env.INGEST_SECRET_TOKEN = "tok-123"
  delete process.env.VERCEL_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.env = { ...origEnv }
})

async function runAfters() {
  for (const cb of afterCbs) await cb()
}

describe("fireNextPipelineStep", () => {
  it("no-ops (no fetch scheduled) when chain flag is false", async () => {
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)
    await fireNextPipelineStep("/api/cron/next", false)
    expect(afterCbs).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it("no-ops when INGEST_SECRET_TOKEN is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)
    await fireNextPipelineStep("/api/cron/next", true)
    expect(afterCbs).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it("POSTs to the default base with bearer token and appends chain=true via '?'", async () => {
    const fetchMock = vi.fn(async () => ({ status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await fireNextPipelineStep("/api/cron/next", true)
    await runAfters()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, any]
    expect(url).toBe("https://www.rippackscity.com/api/cron/next?chain=true")
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Bearer tok-123")
  })

  it("uses VERCEL_URL base and '&' separator when the path already has a query string", async () => {
    process.env.VERCEL_URL = "preview.vercel.app"
    const fetchMock = vi.fn(async () => ({ status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    await fireNextPipelineStep("/api/cron/next?force=true", true)
    await runAfters()
    const [url] = fetchMock.mock.calls[0] as unknown as [string, any]
    expect(url).toBe("https://preview.vercel.app/api/cron/next?force=true&chain=true")
  })

  it("swallows a fetch rejection inside after()", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net fail") }))
    await fireNextPipelineStep("/api/cron/next", true)
    // The after() callback must not reject.
    await expect(runAfters()).resolves.toBeUndefined()
  })
})
