import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  buildDay1Html,
  buildDay1Subject,
  buildDay1Text,
  day1CtaUrl,
  formatUsd,
  hasValueLine,
} from "@/lib/emails/day1-onboarding-email"
import { num, toRecipient } from "@/lib/emails/day1-onboarding-recipients"

// /api/cron/day1-onboarding (2026-11-16): the once-per-account day-1 email.
// Route guards (auth, INERT by default, postal-address gate, a dry run that never
// returns an address, once-per-account dedup, a failed send counted not thrown)
// plus the copy rules (no $0 value, no tier, no purchase/paid-tier/superiority).

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
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { h.afterFns.push(fn) } }
})

import { GET, POST } from "@/app/api/cron/day1-onboarding/route"

const TOKEN = "test-ingest-token"
function makeReq(opts: { auth?: string; params?: Record<string, string> } = {}) {
  const u = new URL("https://t/api/cron/day1-onboarding")
  for (const [k, v] of Object.entries(opts.params ?? {})) u.searchParams.set(k, v)
  return { nextUrl: u, headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? opts.auth ?? null : null) } } as any
}

const walletRow = { user_id: "u-1111-2222", email: "Collector@Example.com", username: "StuBucksman", segment: "wallet", fmv_usd: "117.63", moment_count: 282, hours_since_signup: "61.4" }
const noWalletRow = { user_id: "u-3333-4444", email: "new@example.com", username: null, segment: "no_wallet", fmv_usd: null, moment_count: null, hours_since_signup: "37.6" }

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  process.env.RPC_SENDER_POSTAL_ADDRESS = "PO Box 123, Portland, OR 97201"
  process.env.RESEND_API_KEY = "test-resend-key"
  delete process.env.DAY1_ONBOARDING_ENABLED
  delete process.env.CRON_SECRET
  h.afterFns = []
  h.fixtures = {
    "rpc:get_day1_onboarding_candidates": { data: [walletRow, noWalletRow], error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    email_subscribers: { data: null, error: null },
    alert_deliveries: { data: null, error: null },
    "alert_deliveries:upsert": { data: [{ id: "claim-1" }], error: null },
    __ops: [] as string[],
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("/api/cron/day1-onboarding", () => {
  it("401s without a valid bearer token", async () => {
    expect((await POST(makeReq())).status).toBe(401)
  })

  it("is INERT by default: 202 skipped=disabled, no send work", async () => {
    const res = await POST(makeReq({ auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    expect((await res.json()).skipped).toBe("disabled")
    expect(h.afterFns.length).toBe(0)
  })

  it("enabled without the CAN-SPAM postal address sends nothing", async () => {
    process.env.DAY1_ONBOARDING_ENABLED = "1"
    delete process.env.RPC_SENDER_POSTAL_ADDRESS
    const res = await POST(makeReq({ auth: `Bearer ${TOKEN}` }))
    expect((await res.json()).skipped).toBe("postal_address_missing")
    expect(h.afterFns.length).toBe(0)
  })

  it("dry run lists who would get which version, and NEVER returns an email address", async () => {
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}`, params: { dry: "1" } }))
    const body = await res.json()
    expect(body.would_send).toBe(2)
    expect(body.recipients.map((r: any) => r.segment)).toEqual(["wallet", "no_wallet"])
    expect(body.recipients[0].subject).toBe("Your collection: about $118 across 282 moments")
    expect(JSON.stringify(body)).not.toMatch(/@/)
    expect(h.afterFns.length).toBe(0)
  })

  it("dry run skips an account already sent its day-1 email, and an unsubscribed one", async () => {
    h.fixtures.alert_deliveries = { data: { id: "already" }, error: null }
    let body = await (await GET(makeReq({ auth: `Bearer ${TOKEN}`, params: { dry: "1" } }))).json()
    expect(body.would_send).toBe(0)
    expect(body.skipped_already_sent).toBe(2)
    h.fixtures.alert_deliveries = { data: null, error: null }
    h.fixtures.email_subscribers = { data: { unsubscribed_at: "2026-11-01T00:00:00Z" }, error: null }
    body = await (await GET(makeReq({ auth: `Bearer ${TOKEN}`, params: { dry: "1" } }))).json()
    expect(body.would_send).toBe(0)
    expect(body.skipped_unsubscribed).toBe(2)
  })

  it("a failed selector read is a 500 in the dry run, never an empty list", async () => {
    h.fixtures["rpc:get_day1_onboarding_candidates"] = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}`, params: { dry: "1" } }))
    expect(res.status).toBe(500)
    expect(await res.json()).not.toHaveProperty("recipients")
  })

  it("enabled: one Resend send per eligible account, to the lowercased address, with an unsubscribe link", async () => {
    process.env.DAY1_ONBOARDING_ENABLED = "1"
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" }) as any)
    vi.stubGlobal("fetch", fetchMock)
    expect((await POST(makeReq({ auth: `Bearer ${TOKEN}` }))).status).toBe(202)
    await h.afterFns[0]()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body)
    expect(first.to).toBe("collector@example.com")
    expect(first.text).toContain("/api/subscribe/unsubscribe?token=")
    expect(first.text).toContain("PO Box 123, Portland, OR 97201")
    expect(first.reply_to).toBe("rippackscity@gmail.com")
  })

  it("enabled: an account already sent is skipped (once per account, ever)", async () => {
    process.env.DAY1_ONBOARDING_ENABLED = "1"
    h.fixtures.alert_deliveries = { data: { id: "already" }, error: null }
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" }) as any)
    vi.stubGlobal("fetch", fetchMock)
    await POST(makeReq({ auth: `Bearer ${TOKEN}` }))
    await h.afterFns[0]()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("enabled: a Resend failure is counted, not thrown", async () => {
    process.env.DAY1_ONBOARDING_ENABLED = "1"
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }) as any)
    vi.stubGlobal("fetch", fetchMock)
    await POST(makeReq({ auth: `Bearer ${TOKEN}` }))
    await expect(h.afterFns[0]()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe("day-1 recipients", () => {
  it("shapes a row; drops one with no address or an unknown segment", () => {
    expect(toRecipient(walletRow as any)).toMatchObject({ email: "collector@example.com", segment: "wallet", fmvUsd: 117.63, momentCount: 282 })
    expect(toRecipient({ ...walletRow, email: null } as any)).toBeNull()
    expect(toRecipient({ ...walletRow, segment: "other" } as any)).toBeNull()
    expect(num("")).toBeNull()
    expect(num("12.5")).toBe(12.5)
  })
})

describe("day-1 copy", () => {
  process.env.RPC_SENDER_POSTAL_ADDRESS = process.env.RPC_SENDER_POSTAL_ADDRESS || "PO Box 123, Portland, OR 97201"
  const unsub = "https://www.rippackscity.com/api/subscribe/unsubscribe?token=t"
  const wallet = { segment: "wallet" as const, username: "crottykid", fmvUsd: 7032.16, momentCount: 10723, unsubscribeUrl: unsub }
  const none = { segment: "no_wallet" as const, username: null, unsubscribeUrl: unsub }

  it("the wallet version leads with the dashboard value, called an estimate", () => {
    expect(buildDay1Subject(wallet)).toBe("Your collection: about $7,032 across 10,723 moments")
    expect(buildDay1Text(wallet)).toMatch(/about \$7,032 across 10,723 moments\. That figure is an estimate/)
    expect(formatUsd(99.31)).toBe("$99.31")
  })

  it("a missing or zero value is never printed — the number is dropped, not shown as $0", () => {
    for (const v of [null, 0, NaN]) {
      const o = { ...wallet, fmvUsd: v as any }
      expect(hasValueLine(o)).toBe(false)
      expect(buildDay1Subject(o)).toBe("Your Rip Packs City dashboard is ready")
      expect(buildDay1Text(o) + buildDay1Html(o)).not.toMatch(/\$0\b|\$NaN/)
    }
  })

  it("the no-wallet version asks for the one missing step and links the dashboard", () => {
    expect(buildDay1Subject(none)).toBe("One step left: add your Top Shot username")
    expect(buildDay1Text(none)).toContain(day1CtaUrl("no_wallet"))
    expect(day1CtaUrl("no_wallet")).toContain("/dashboard?utm_source=email&utm_medium=day1")
  })

  it("carries the unsubscribe link and the postal address, and obeys the founder's copy rules", () => {
    for (const o of [wallet, none]) {
      const all = `${buildDay1Subject(o)}\n${buildDay1Text(o)}\n${buildDay1Html(o)}`
      expect(all).toContain(unsub)
      expect(all).toContain("PO Box 123")
      expect(all).not.toMatch(/\b(pro|premium|upgrade|paid|subscription|beta)\b/i)
      expect(all).not.toMatch(/\b(buy|cart|checkout|gift|sell)\b/i)
      expect(all).not.toMatch(/most accurate|more accurate|better than|only platform|#1\b/i)
      expect(all).not.toMatch(/team captain|trail blazers/i)
      expect(all).not.toMatch(/\b(HIGH|MEDIUM|LOW) confidence|confidence/i)
    }
  })

  it("escapes a hostile username", () => {
    expect(buildDay1Html({ ...wallet, username: "<img src=x>" })).not.toContain("<img src=x>")
  })
})
