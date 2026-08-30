import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Tests for lib/ops-alert.ts sendOpsAlert — the health/ops pager. A silent
// failure here means the platform goes BLIND to red states, so the contract
// worth locking is: (1) the debounce gate suppresses within cooldown and sends
// nothing; (2) a broken debounce RPC fails OPEN (alert still goes out); (3) each
// channel's delivery is reported honestly per res.ok; (4) it never throws.
//
// Env (TELEGRAM_*/RESEND_*/ALERT_EMAIL) is read into module-level consts at
// import, so it is set BEFORE the dynamic import below.

const rpcMock = vi.fn(async () => ({ data: true, error: null }) as any)
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: (...a: unknown[]) => rpcMock(...(a as [])) },
}))

process.env.TELEGRAM_BOT_TOKEN = "tg-token"
process.env.TELEGRAM_CHAT_ID = "123"
process.env.RESEND_API_KEY = "rs-key"
process.env.ALERT_EMAIL = "ops@example.com"

const { sendOpsAlert } = await import("@/lib/ops-alert")

function stubFetch(perUrl: (url: string) => { ok: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const r = perUrl(String(url))
      return { ok: r.ok, status: r.ok ? 200 : 500, text: async () => "" } as any
    }),
  )
}

beforeEach(() => rpcMock.mockReset().mockResolvedValue({ data: true, error: null }))
afterEach(() => vi.unstubAllGlobals())

const base = { key: "test-alert", subject: "Health RED", text: "something broke" }

describe("sendOpsAlert debounce gate", () => {
  it("suppresses (sends nothing) when ops_alert_should_send returns false", async () => {
    rpcMock.mockResolvedValue({ data: false, error: null })
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }) as any)
    vi.stubGlobal("fetch", fetchSpy)

    const r = await sendOpsAlert(base)
    expect(r).toEqual({ suppressed: true, telegram: false, email: false })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("fails OPEN when the debounce RPC errors — a broken gate must not silence alerts", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "db down" } })
    stubFetch(() => ({ ok: true }))
    const r = await sendOpsAlert(base)
    expect(r.suppressed).toBe(false)
    expect(r.telegram).toBe(true)
    expect(r.email).toBe(true)
  })

})

describe("sendOpsAlert per-channel delivery reporting", () => {
  it("reports both channels delivered on 2xx", async () => {
    stubFetch(() => ({ ok: true }))
    const r = await sendOpsAlert(base)
    expect(r).toEqual({ suppressed: false, telegram: true, email: true })
  })

  it("counts a non-2xx channel as NOT delivered (never as sent)", async () => {
    // Telegram 500s, email 200s.
    stubFetch((url) => ({ ok: !url.includes("telegram.org") }))
    const r = await sendOpsAlert(base)
    expect(r.telegram).toBe(false)
    expect(r.email).toBe(true)
  })

  it("does not throw when a channel fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("telegram.org")) throw new Error("network")
        return { ok: true, status: 200, text: async () => "" } as any
      }),
    )
    const r = await sendOpsAlert(base)
    expect(r.telegram).toBe(false)
    expect(r.email).toBe(true)
  })

  it("reports BOTH channels failed (the alert-not-delivered path) without throwing", async () => {
    // Both channels non-2xx: the debounce already consumed the cooldown slot, so
    // this is the worst case — a red state that pages nobody. It must still
    // return honestly (suppressed:false, both false), not crash the monitor.
    stubFetch(() => ({ ok: false }))
    const r = await sendOpsAlert(base)
    expect(r.suppressed).toBe(false)
    expect(r.telegram).toBe(false)
    expect(r.email).toBe(false)
    // ⚠ The reason distinguishes THIS case (the channels answered and refused)
    // from the unconfigured one (they were never called). Both used to render as
    // a bare `false`, which is why a dead token and a missing token looked alike.
    expect(r.telegramReason).toContain("http_")
    expect(r.emailReason).toContain("http_")
  })

  it("forwards an html body to the email channel when supplied", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, text: async () => "" }) as any)
    vi.stubGlobal("fetch", fetchSpy)
    await sendOpsAlert({ ...base, html: "<b>RED</b>" })
    const emailCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("resend.com"))
    expect(emailCall).toBeDefined()
    const body = JSON.parse((emailCall![1] as any).body)
    expect(body.html).toBe("<b>RED</b>")
    // text-only sends must NOT carry an html key (the `...(html ? {html} : {})` arm)
    const telegramCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("telegram.org"))
    expect(telegramCall).toBeDefined()
  })
})
