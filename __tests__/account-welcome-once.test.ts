import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The once-per-account transactional welcome (platform review 2026-10-11, M2):
// lib/welcome/send-account-welcome.ts + lib/emails/account-welcome-email.ts.
//
// WHAT IS PINNED, as absences where it matters:
//   * nothing is sent unless the DB claim returns exactly `true` — false, null,
//     an error, or a thrown RPC all mean ZERO sends, and none of them throws out
//     of the helper (a sign-in must never fail on a welcome);
//   * a failed send REVERTS the claim through record_welcome_email_failure with
//     the error text — a swallowed send failure would mean "never welcomed";
//   * the email carries the real From address the other emails use (same literal
//     as lib/allow-list/prewarm.ts), a manage/preferences link, the one-time
//     notice, and NONE of the forbidden copy: no paid tier, no buying, no
//     superiority claim, no Team Captain.
//
// ⚠ PLANTED-DEFECT PROOF (run 2026-10-11): with the helper edited to treat a
// `null` claim result as claimed (`claimed = data !== false`), "sends nothing
// when the claim returns false/null" failed (send called once); with the revert
// call removed, "a failed send reverts the claim" failed (rpc never called with
// record_welcome_email_failure). Both edits reverted.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import {
  sendAccountWelcomeOnce,
  sendViaResend,
  WELCOME_FROM_ADDRESS,
  type SendEmailArgs,
} from "@/lib/welcome/send-account-welcome"
import {
  ACCOUNT_WELCOME_MANAGE_URL,
  buildAccountWelcomeHtml,
  buildAccountWelcomeSubject,
  buildAccountWelcomeText,
} from "@/lib/emails/account-welcome-email"

const USER = "11111111-1111-1111-1111-111111111111"
const EMAIL = "collector@example.com"

function harness(claim: { data?: unknown; error?: { message: string } | null; throws?: Error }, sendOutcome?: "ok" | "fail" | "throw") {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const sends: SendEmailArgs[] = []
  const logs: string[] = []
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      if (fn === "claim_welcome_email") {
        if (claim.throws) throw claim.throws
        return { data: claim.data ?? null, error: claim.error ?? null }
      }
      return { data: null, error: null }
    },
  }
  const send = async (a: SendEmailArgs) => {
    sends.push(a)
    if (sendOutcome === "throw") throw new Error("socket hang up")
    if (sendOutcome === "fail") return { ok: false as const, error: "Resend HTTP 500: boom" }
    return { ok: true as const }
  }
  return { db, send, rpcCalls, sends, log: (l: string) => logs.push(l), logs }
}

describe("sendAccountWelcomeOnce — the claim decides", () => {
  it("claims, then sends ONCE with the real From, the manage link and the one-time notice", async () => {
    const h = harness({ data: true }, "ok")
    const res = await sendAccountWelcomeOnce({ userId: USER, email: EMAIL }, h)
    expect(res).toEqual({ status: "sent" })
    expect(h.rpcCalls.map((c) => c.fn)).toEqual(["claim_welcome_email"])
    expect(h.rpcCalls[0].args).toEqual({ p_user_id: USER })
    expect(h.sends).toHaveLength(1)
    const s = h.sends[0]
    expect(s.from).toBe(WELCOME_FROM_ADDRESS)
    expect(s.to).toBe(EMAIL)
    expect(s.subject).toBe(buildAccountWelcomeSubject())
    expect(s.html).toContain(ACCOUNT_WELCOME_MANAGE_URL)
    expect(s.html).toMatch(/Manage your account and email preferences/)
    expect(s.html).toMatch(/one-time notice/)
    expect(s.text).toContain(ACCOUNT_WELCOME_MANAGE_URL)
    expect(s.text).toMatch(/one-time notice/)
  })

  it.each([
    ["false", { data: false }],
    ["null", { data: null }],
    ["a string 'true'", { data: "true" }],
  ])("sends NOTHING when the claim returns %s (not exactly true)", async (_l, claim) => {
    const h = harness(claim as { data: unknown }, "ok")
    const res = await sendAccountWelcomeOnce({ userId: USER, email: EMAIL }, h)
    expect(res).toEqual({ status: "not_claimed" })
    expect(h.sends).toHaveLength(0)
    // and no failure is recorded — there was nothing to revert
    expect(h.rpcCalls.map((c) => c.fn)).toEqual(["claim_welcome_email"])
  })

  it("a claim ERROR sends nothing and does not throw", async () => {
    const h = harness({ error: { message: "function claim_welcome_email(uuid) does not exist" } }, "ok")
    const res = await sendAccountWelcomeOnce({ userId: USER, email: EMAIL }, h)
    expect(res).toMatchObject({ status: "claim_failed", error: expect.stringMatching(/does not exist/) })
    expect(h.sends).toHaveLength(0)
    expect(h.logs.join("\n")).toMatch(/claim failed/)
  })

  it("a THROWN claim sends nothing and does not throw", async () => {
    const h = harness({ throws: new Error("ECONNRESET") }, "ok")
    await expect(sendAccountWelcomeOnce({ userId: USER, email: EMAIL }, h)).resolves.toMatchObject({
      status: "claim_failed",
      error: "ECONNRESET",
    })
    expect(h.sends).toHaveLength(0)
  })

  it("a FAILED send reverts the claim with the error text, and reports send_failed", async () => {
    const h = harness({ data: true }, "fail")
    const res = await sendAccountWelcomeOnce({ userId: USER, email: EMAIL }, h)
    expect(res).toEqual({ status: "send_failed", error: "Resend HTTP 500: boom" })
    expect(h.rpcCalls.map((c) => c.fn)).toEqual(["claim_welcome_email", "record_welcome_email_failure"])
    expect(h.rpcCalls[1].args).toEqual({ p_user_id: USER, p_error: "Resend HTTP 500: boom" })
  })

  it("a THROWN send is treated as a failed send (reverted), never propagated", async () => {
    const h = harness({ data: true }, "throw")
    const res = await sendAccountWelcomeOnce({ userId: USER, email: EMAIL }, h)
    expect(res).toMatchObject({ status: "send_failed", error: expect.stringMatching(/socket hang up/) })
    expect(h.rpcCalls[1]).toMatchObject({ fn: "record_welcome_email_failure" })
  })

  it("bad input is skipped before any RPC — no claim is burnt on a missing email", async () => {
    const h = harness({ data: true }, "ok")
    expect(await sendAccountWelcomeOnce({ userId: USER, email: null }, h)).toMatchObject({ status: "skipped" })
    expect(await sendAccountWelcomeOnce({ userId: "", email: EMAIL }, h)).toMatchObject({ status: "skipped" })
    expect(await sendAccountWelcomeOnce({ userId: USER, email: "not-an-address" }, h)).toMatchObject({ status: "skipped" })
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.sends).toHaveLength(0)
  })
})

describe("the From address is the one the other emails use", () => {
  it("matches lib/allow-list/prewarm.ts FROM_ADDRESS literally", () => {
    const prewarm = readFileSync(join(process.cwd(), "lib/allow-list/prewarm.ts"), "utf8")
    const m = /const FROM_ADDRESS = "([^"]+)"/.exec(prewarm)
    expect(m).not.toBeNull()
    expect(WELCOME_FROM_ADDRESS).toBe(m![1])
    expect(WELCOME_FROM_ADDRESS).toMatch(/@rippackscity\.com>$/)
  })
})

describe("the welcome copy obeys the founder's rules", () => {
  const html = buildAccountWelcomeHtml({ email: EMAIL })
  const text = buildAccountWelcomeText({ email: EMAIL })
  const both = `${html}\n${text}\n${buildAccountWelcomeSubject()}`

  it("names the address, links sign-in and the manage page, and says it is one-time and non-marketing", () => {
    expect(html).toContain(EMAIL)
    expect(text).toContain(EMAIL)
    expect(html).toContain("https://www.rippackscity.com/login")
    expect(text).toContain("https://www.rippackscity.com/login")
    expect(html).toContain(ACCOUNT_WELCOME_MANAGE_URL)
    expect(text).toContain(ACCOUNT_WELCOME_MANAGE_URL)
    expect(both).toMatch(/do not send marketing email/i)
    expect(both).toMatch(/not appraisals or advice/)
  })

  it("contains no paid-tier, purchase, superiority or Team Captain copy", () => {
    expect(both).not.toMatch(/\b(pro|premium|upgrade|paid|pricing|subscription|beta)\b/i)
    expect(both).not.toMatch(/\b(buy|cart|checkout|trade|gift|sell)\b/i)
    expect(both).not.toMatch(/most accurate|more accurate|better than|beats?\b|than any|only platform|#1\b/i)
    expect(both).not.toMatch(/team captain|trail blazers/i)
  })

  it("escapes the address in HTML", () => {
    const h = buildAccountWelcomeHtml({ email: 'x"<script>@example.com' })
    expect(h).not.toContain("<script>")
    expect(h).toContain("&lt;script&gt;")
  })
})

describe("sendViaResend — the default sender never throws", () => {
  it("fails soft without an API key", async () => {
    vi.stubEnv("RESEND_API_KEY", "")
    const r = await sendViaResend({ from: "a", to: "b", subject: "c", html: "d", text: "e" })
    expect(r).toEqual({ ok: false, error: "RESEND_API_KEY is not set" })
    vi.unstubAllEnvs()
  })

  it("reports a non-2xx and a thrown fetch as ok:false with the reason", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    const f = vi.fn(async () => new Response("quota", { status: 429 }))
    vi.stubGlobal("fetch", f)
    expect(await sendViaResend({ from: "a", to: "b", subject: "c", html: "d", text: "e" })).toEqual({
      ok: false,
      error: "Resend HTTP 429: quota",
    })
    const payload = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(payload).toMatchObject({ from: "a", to: ["b"], subject: "c" })
    vi.stubGlobal("fetch", async () => { throw new Error("down") })
    expect(await sendViaResend({ from: "a", to: "b", subject: "c", html: "d", text: "e" })).toEqual({
      ok: false,
      error: "Resend threw: down",
    })
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
})
