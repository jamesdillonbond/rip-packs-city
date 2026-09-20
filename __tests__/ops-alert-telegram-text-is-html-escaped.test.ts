import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * Companion to `sentinel-telegram-lines-are-html-escaped.test.ts`. The sentinel
 * lost its Telegram channel for five hours on 2026-09-19 because a `<` in a
 * data-built detail reached a `parse_mode: "HTML"` send unescaped. `sendOpsAlert`
 * is the OTHER Telegram sender fed by data — smoke-test failure details (which
 * carried Cloudflare's `<!DOCTYPE html>` verbatim during the 09-18 outage),
 * data-integrity issue strings — and had the identical hole.
 *
 * Contract pinned here: the Telegram body is escaped, the email body is NOT (it
 * is sent as plain `text`, where `&lt;` would be a lie), and a message with
 * nothing to escape is byte-identical to before.
 */

const rpcMock = vi.fn(async () => ({ data: true, error: null }) as any)
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: (...a: unknown[]) => rpcMock(...(a as [])) },
}))

process.env.TELEGRAM_BOT_TOKEN = "tg-token"
process.env.TELEGRAM_CHAT_ID = "123"
process.env.RESEND_API_KEY = "rs-key"
process.env.ALERT_EMAIL = "ops@example.com"

const { sendOpsAlert } = await import("@/lib/ops-alert")

type Sent = { url: string; body: any }

function captureFetch(): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) })
      return { ok: true, status: 200, text: async () => "" } as any
    }),
  )
  return sent
}

const telegramOf = (sent: Sent[]) => sent.find((s) => s.url.includes("api.telegram.org"))!
const emailOf = (sent: Sent[]) => sent.find((s) => s.url.includes("api.resend.com"))!

beforeEach(() => rpcMock.mockReset().mockResolvedValue({ data: true, error: null }))
afterEach(() => vi.unstubAllGlobals())

// The shape the smoke-test sender produced during the 2026-09-18 origin outage:
// a Cloudflare HTML page in the failure detail.
const OUTAGE_TEXT =
  "Smoke test hard failures (hard 40/43):\n" +
  "  • /api/public/insights/deals (502): <!DOCTYPE html><html lang=\"en-US\"><head><title>supabase.co | 522: Connection timed out</title>"

describe("sendOpsAlert escapes the Telegram body for parse_mode HTML", () => {
  it("POSITIVE CONTROL: the outage text really does carry a raw `<` Telegram would reject", () => {
    expect(OUTAGE_TEXT).toMatch(/<!DOCTYPE/)
  })

  it("sends Telegram an escaped body and email the plain one", async () => {
    const sent = captureFetch()
    const r = await sendOpsAlert({ key: "escape-test", subject: "RED", text: OUTAGE_TEXT })
    expect(r.telegram).toBe(true)

    const tg = telegramOf(sent).body
    expect(tg.parse_mode).toBe("HTML")
    expect(tg.text).not.toMatch(/</)
    expect(tg.text).toContain("&lt;!DOCTYPE html&gt;")
    // Quotes are NOT escaped — Telegram does not require it, and `&quot;` in a
    // pager line is noise a reader has to decode.
    expect(tg.text).toContain('lang="en-US"')

    // The email channel is plain text: the SAME string, unescaped.
    const em = emailOf(sent).body
    expect(em.text).toBe(OUTAGE_TEXT)
  })

  it("leaves a message with nothing to escape byte-identical (no-change control)", async () => {
    const sent = captureFetch()
    const plain = "FMV has not recomputed in 95 min (threshold 90 min). Last sale 12 min ago."
    await sendOpsAlert({ key: "plain-test", subject: "RED", text: plain })
    expect(telegramOf(sent).body.text).toBe(plain)
    expect(emailOf(sent).body.text).toBe(plain)
  })

  it("escapes BEFORE bounding, so the truncation notice itself is never mangled", async () => {
    // If the order were fit-then-escape, the `…[N more characters omitted …]`
    // notice would still be fine — but an escape AFTER the cut can grow the text
    // past the limit again (`<` → `&lt;` is 4× longer). Escape first, then fit.
    const sent = captureFetch()
    await sendOpsAlert({ key: "long-test", subject: "RED", text: "<".repeat(5000) })
    const t = telegramOf(sent).body.text as string
    expect(t.length).toBeLessThanOrEqual(4096)
    expect(t).not.toMatch(/<(?!\/?b>)/)
    expect(t).toMatch(/more characters omitted/)
  })
})
