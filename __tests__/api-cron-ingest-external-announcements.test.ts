import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET/POST /api/cron/ingest-external-announcements.
// Fail-closed auth: the handler accepts Bearer INGEST_SECRET_TOKEN / CRON_SECRET
// or ?token=INGEST_SECRET_TOKEN and 401s otherwise before serving its retirement
// notice. The token is captured at MODULE LOAD (`const INGEST_SECRET_TOKEN =
// process.env.INGEST_SECRET_TOKEN!`), so the success path is exercised via a
// two-regime dynamic import with the secret set before import.
//
// This route was retired 2026-05-07: its authed "success" response is a
// structured 410 Gone (`{ error:"gone", replacement:"/api/admin/announcements" }`)
// so stale cron-job.org schedules get a clean signal instead of a pipeline
// failure. We drive that 410 accept and assert the body.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/ingest-external-announcements"),
  }) as any

import { GET } from "@/app/api/cron/ingest-external-announcements/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("GET /api/cron/ingest-external-announcements — auth guards", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("GET /api/cron/ingest-external-announcements — retirement 410 (authed accept)", () => {
  const TOKEN = "ext-ann-ingest-token"
  const url = "https://t/api/cron/ingest-external-announcements"
  const savedIngest = process.env.INGEST_SECRET_TOKEN
  let SGET: (req: any) => Promise<Response>
  let SPOST: (req: any) => Promise<Response>

  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/cron/ingest-external-announcements/route")
    SGET = mod.GET as any
    SPOST = mod.POST as any
  })

  afterAll(() => {
    if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
    else process.env.INGEST_SECRET_TOKEN = savedIngest
  })

  it("410s 'gone' with the correct bearer token and names the replacement", async () => {
    const res = await SGET(makeReq({ url, method: "GET", auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(410)
    const body = await res.json()
    expect(body.error).toBe("gone")
    expect(body.replacement).toBe("/api/admin/announcements")
    expect(body.retired_at).toBe("2026-05-07")
  })

  it("410s with the correct ?token= query param", async () => {
    const res = await SGET(makeReq({ url, method: "GET", token: TOKEN }))
    expect(res.status).toBe(410)
    expect((await res.json()).error).toBe("gone")
  })

  it("POST delegates to GET and reaches the same 410 accept when authed", async () => {
    const res = await SPOST(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(410)
    expect((await res.json()).replacement).toBe("/api/admin/announcements")
  })
})
