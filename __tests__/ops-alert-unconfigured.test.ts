import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Companion to ops-alert.test.ts. That suite runs with every channel env set, so
// the `if (!TOKEN || !CHAT_ID) return false` / `if (!RESEND_KEY || !EMAIL) return
// false` guards at the top of sendTelegram/sendEmail are never taken there.
//
// ops-alert.ts reads the channel env into module-level consts AT IMPORT, so the
// only way to exercise the "channel not configured" guards is a separate module
// instance imported with the env UNSET. That is the realistic misconfiguration —
// a deploy missing TELEGRAM_CHAT_ID or ALERT_EMAIL — and the contract worth
// pinning is that it degrades to a silent no-send for that channel (returns
// false, never a thrown error and never a fetch to a half-configured endpoint).

const rpcMock = vi.fn(async () => ({ data: true, error: null }) as any)
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: (...a: unknown[]) => rpcMock(...(a as [])) },
}))

// Clear every channel credential BEFORE importing the module under test.
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID
delete process.env.RESEND_API_KEY
delete process.env.ALERT_EMAIL

const { sendOpsAlert } = await import("@/lib/ops-alert")

beforeEach(() => rpcMock.mockReset().mockResolvedValue({ data: true, error: null }))
afterEach(() => vi.unstubAllGlobals())

describe("sendOpsAlert with no channels configured", () => {
  it("sends nothing (both channels report false) and never calls fetch", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }) as any)
    vi.stubGlobal("fetch", fetchSpy)

    const r = await sendOpsAlert({ key: "unconfigured", subject: "RED", text: "broke" })

    // Not within cooldown (the RPC allows it), but both channels are unconfigured,
    // so the result is a real, honest "delivered nothing" — not suppressed.
    // ⚠ Pinned as PROPERTIES, not as object equality (2026-08-30). The result
    // gained `telegramReason`/`emailReason`, which is additive — the booleans
    // keep their exact meaning — and a `toEqual` on the whole object is a
    // spelling pin that reds on any honest addition.
    expect(r.suppressed).toBe(false)
    expect(r.telegram).toBe(false)
    expect(r.email).toBe(false)
    // And the new part, which is the point: an unconfigured channel now SAYS SO
    // rather than being an unexplained false.
    expect(r.telegramReason).toBe("not_configured")
    expect(r.emailReason).toBe("not_configured")
    // The guards short-circuit BEFORE any network call.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("does not throw when the pager is fully unconfigured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }) as any))
    await expect(
      sendOpsAlert({ key: "unconfigured-2", subject: "RED", text: "broke" }),
    ).resolves.toBeDefined()
  })
})
