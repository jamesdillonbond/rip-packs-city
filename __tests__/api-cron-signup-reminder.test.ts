import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"
import {
  buildSignupReminderSubject,
  buildSignupReminderHtml,
  buildSignupReminderText,
  shortWallet,
} from "@/lib/emails/signup-reminder-email"

// Route test for /api/cron/signup-reminder — the cold-signup re-engagement cron.
// Covers the guards that matter: auth, the INERT disabled path (sends nothing
// unless SIGNUP_REMINDER_ENABLED=1), the ?dry=1 preview (eligible/dedup/
// unsubscribe filtering), and the enabled send loop (after() driven with a
// mocked Resend fetch). Plus unit coverage of the email template.

const h = vi.hoisted(() => ({
  fixtures: {} as Record<string, unknown>,
  afterFns: [] as Array<() => Promise<void>>,
}))

vi.mock("@/lib/supabase", async () => {
  const { makeSupabaseFixture: mk } = await import("./helpers/route-harness")
  return {
    get supabaseAdmin() {
      return mk(h.fixtures as any)
    },
  }
})

// Capture next/server's after() callback so the test can run the send loop
// synchronously, while keeping the real NextResponse.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return {
    ...actual,
    after: (fn: () => Promise<void>) => {
      h.afterFns.push(fn)
    },
  }
})

import { GET, POST } from "@/app/api/cron/signup-reminder/route"

const TOKEN = "test-ingest-token"

function makeReq(opts: { auth?: string; params?: Record<string, string> } = {}) {
  const u = new URL("https://t/api/cron/signup-reminder")
  for (const [k, v] of Object.entries(opts.params ?? {})) u.searchParams.set(k, v)
  return {
    nextUrl: u,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "authorization" ? opts.auth ?? null : null,
    },
  } as any
}

const chaseRow = {
  email: "chase.standen@gmail.com",
  wallet_addr: "0x3a7607b98be62a96",
  username: "oofowiemywallet",
  approved_at: "2026-07-20T20:44:06.731Z",
  hours_since_approved: 99.6,
  stage: "nudge2",
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  process.env.RESEND_API_KEY = "test-resend-key"
  delete process.env.SIGNUP_REMINDER_ENABLED
  h.afterFns = []
  h.fixtures = {
    "rpc:get_cold_signup_reminders": { data: [chaseRow], error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    email_subscribers: { data: null, error: null },
    alert_deliveries: { data: null, error: null },
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("/api/cron/signup-reminder", () => {
  it("401s without a valid bearer token", async () => {
    const res = await POST(makeReq())
    expect(res.status).toBe(401)
  })

  it("is INERT by default: 202 skipped=disabled when the flag is unset", async () => {
    const res = await POST(makeReq({ auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.skipped).toBe("disabled")
    expect(body.pipeline).toBe("signup-reminder")
    // disabled path must not schedule any send work
    expect(h.afterFns.length).toBe(0)
  })

  it("dry-run previews eligible recipients and sends nothing", async () => {
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}`, params: { dry: "1" } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.dry).toBe(true)
    expect(body.enabled).toBe(false)
    expect(body.eligible_total).toBe(1)
    expect(body.would_send).toBe(1)
    expect(body.recipients[0].email).toBe("chase.standen@gmail.com")
    expect(body.recipients[0].stage).toBe("nudge2")
    expect(h.afterFns.length).toBe(0)
  })

  it("dry-run skips a recipient already reminded at this stage", async () => {
    h.fixtures.alert_deliveries = { data: { id: "already" }, error: null }
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}`, params: { dry: "1" } }))
    const body = await res.json()
    expect(body.would_send).toBe(0)
    expect(body.skipped_already_sent).toBe(1)
  })

  it("dry-run skips an unsubscribed recipient", async () => {
    h.fixtures.email_subscribers = { data: { unsubscribed_at: "2026-07-01T00:00:00Z" }, error: null }
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}`, params: { dry: "1" } }))
    const body = await res.json()
    expect(body.would_send).toBe(0)
    expect(body.skipped_unsubscribed).toBe(1)
  })

  it("dry-run reports empty when no one is eligible", async () => {
    h.fixtures["rpc:get_cold_signup_reminders"] = { data: [], error: null }
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}`, params: { dry: "1" } }))
    const body = await res.json()
    expect(body.eligible_total).toBe(0)
    expect(body.would_send).toBe(0)
  })

  it("enabled: accepts (202) and the send loop emails eligible recipients", async () => {
    process.env.SIGNUP_REMINDER_ENABLED = "1"
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" }) as any)
    vi.stubGlobal("fetch", fetchMock)

    const res = await POST(makeReq({ auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)

    // run the captured after() send loop
    expect(h.afterFns.length).toBe(1)
    await h.afterFns[0]()

    // one Resend send for the single eligible recipient
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as any[]
    expect(String(url)).toContain("api.resend.com")
    expect(String(init.body)).toContain("chase.standen@gmail.com")
  })

  it("enabled: skips a recipient already reminded at this stage (no send)", async () => {
    process.env.SIGNUP_REMINDER_ENABLED = "1"
    h.fixtures.alert_deliveries = { data: { id: "already" }, error: null }
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" }) as any)
    vi.stubGlobal("fetch", fetchMock)

    const res = await POST(makeReq({ auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    await h.afterFns[0]()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("enabled: a Resend failure is counted, not thrown", async () => {
    process.env.SIGNUP_REMINDER_ENABLED = "1"
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }) as any)
    vi.stubGlobal("fetch", fetchMock)

    const res = await POST(makeReq({ auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    await expect(h.afterFns[0]()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("signup-reminder email template", () => {
  it("subject differs by stage", () => {
    expect(buildSignupReminderSubject({ email: "a@b.com", stage: "nudge2" })).toContain("Still there")
    expect(buildSignupReminderSubject({ email: "a@b.com", stage: "nudge1" })).toContain("One step left")
  })

  it("shortWallet truncates long addresses, passes short ones, handles null", () => {
    expect(shortWallet("0x3a7607b98be62a96")).toBe("0x3a76…2a96")
    expect(shortWallet("short")).toBe("short")
    expect(shortWallet(null)).toBeNull()
    expect(shortWallet(undefined)).toBeNull()
  })

  it("html carries the login CTA, the short wallet, and the unsubscribe link", () => {
    const html = buildSignupReminderHtml({
      email: "a@b.com",
      wallet_addr: "0x3a7607b98be62a96",
      username: "collector",
      stage: "nudge2",
      unsubscribeUrl: "https://www.rippackscity.com/api/subscribe/unsubscribe?token=xyz",
    })
    expect(html).toContain("rippackscity.com/login")
    expect(html).toContain("0x3a76…2a96")
    expect(html).toContain("Stop these reminders")
    expect(html).toContain("collector")
  })

  it("html reads cleanly with no wallet and no unsubscribe url", () => {
    const html = buildSignupReminderHtml({ email: "a@b.com" })
    expect(html).toContain("waiting on your first sign-in")
    expect(html).not.toContain("Stop these reminders")
  })

  it("text version carries the login link and wallet", () => {
    const text = buildSignupReminderText({ email: "a@b.com", wallet_addr: "0x3a7607b98be62a96" })
    expect(text).toContain("Sign in: https://www.rippackscity.com/login")
    expect(text).toContain("0x3a76…2a96")
  })
})
