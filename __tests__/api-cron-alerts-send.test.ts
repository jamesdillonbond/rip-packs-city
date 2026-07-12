import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET/POST /api/cron/alerts-send.
// Fail-closed auth: run() checks a Bearer token (INGEST_SECRET_TOKEN /
// CRON_SECRET) before draining the alert outbox and returns 401 on a missing or
// wrong token. We pin that guard AND drive the real accept: the token is read at
// REQUEST time, the Supabase client is a createClient() instance, and the
// per-channel send runs inside after() (stubbed no-op), so the immediate 202
// { ok, accepted, pipeline, channels } ack — including the resolved channel list
// (all three by default, one when ?channel= narrows it) — is observable with no
// send I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (_fn?: any) => {} }
})
const sb: any = vi.hoisted(() => {
  const s: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "neq", "or", "range", "match", "insert", "update", "upsert", "delete", "returns"]) s[m] = () => s
  s.single = async () => ({ data: {}, error: null })
  s.maybeSingle = async () => ({ data: null, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.then = (resolve: any) => resolve({ data: [], error: null })
  return s
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))
vi.mock("@/lib/alerts", () => ({
  CHANNELS: ["email", "telegram", "discord"],
  claimPendingDeliveries: async () => ({ deliveries: [] }),
  markDeliverySent: async () => {},
  markDeliveryFailed: async () => {},
}))
vi.mock("@/lib/alerts/format", () => ({
  buildEmailMessage: () => ({ subject: "", html: "", text: "" }),
  buildTelegramMessage: () => "",
  buildDiscordEmbeds: () => [],
}))

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/alerts-send"),
  }) as any

import { POST, GET } from "@/app/api/cron/alerts-send/route"

const url = "https://t/api/cron/alerts-send"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/alerts-send", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/alerts-send — success path (immediate ack, sends deferred)", () => {
  it("202s and reports pipeline + all three channels with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("alerts-send")
    expect(body.channels).toEqual(["email", "telegram", "discord"])
  })

  it("narrows to a single channel when ?channel= is a known channel", async () => {
    const res = await POST(makeReq({ url: `${url}?channel=email`, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).channels).toEqual(["email"])
  })

  it("GET alias reaches the same 202 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).pipeline).toBe("alerts-send")
  })
})
