import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fitTelegramMessage, fitTelegramText, TELEGRAM_TEXT_LIMIT } from "@/lib/telegram-message"

/**
 * 🚨 OBSERVED LIVE 2026-09-11T00:01:09Z, and it is the reason this file exists.
 * The sentinel ran 18 checks, concluded CRITICAL (`Pipeline Silence`, during the
 * 09-10 outage) and got back
 *
 *     telegram-FAILED:http_400: … "Bad Request: message is too long"
 *
 * with email `not_configured` alongside it. Both out-of-band channels failed;
 * the fleet alarm detected a real outage and could not tell anyone.
 *
 * ⭐ THE GENERALISABLE DEFECT: the message is one line per check and
 * `Pipeline Silence` names every silent lane, so THE MESSAGE GROWS WITH THE
 * INCIDENT. Telegram rejects — it does not truncate — past 4096 characters. So
 * the alarm was least likely to be delivered on exactly the runs that mattered
 * most, and its failure was visible only as silence.
 *
 * ⚠ The contract is not "it fits". It is "it fits AND the reader can tell what
 * was removed" — a truncation nobody can see is the same defect one level down,
 * and a bare "N omitted" would let a reader believe the alert they received was
 * the alert that was raised. So every case below pairs a length bound with an
 * assertion about what the message SAYS about its own cut.
 */

const line = (status: string, name: string, chars: number) => ({
  status,
  name,
  text: `${name}: ${"x".repeat(chars)}`,
})

describe("fitTelegramText", () => {
  it("leaves a message that already fits completely untouched", () => {
    // Negative control: the common case must not acquire a truncation notice,
    // or every ordinary alert starts claiming something was dropped.
    const text = "short and fine"
    expect(fitTelegramText(text)).toBe(text)
    expect(fitTelegramText("y".repeat(TELEGRAM_TEXT_LIMIT))).toHaveLength(TELEGRAM_TEXT_LIMIT)
  })

  it("bounds an over-long message and says how much it dropped", () => {
    const out = fitTelegramText("z".repeat(10_000))
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
    expect(out).toMatch(/more characters omitted/)
    // The number has to be the real one — a notice with a wrong count is worse
    // than none, because it reads as precision.
    const dropped = Number(out.match(/\[(\d+) more characters/)?.[1])
    const kept = out.indexOf("\n…[")
    expect(dropped + kept).toBe(10_000)
  })

  it("never exceeds the limit, across a wide range of sizes and limits", () => {
    // The notice's own length depends on the numbers inside it, so "reserve a
    // fixed 60 characters" is the shape that fails at a boundary nobody tested.
    for (const limit of [40, 80, 200, 1000, TELEGRAM_TEXT_LIMIT]) {
      for (const size of [0, 1, limit - 1, limit, limit + 1, limit * 3, 50_000]) {
        const out = fitTelegramText("q".repeat(size), limit)
        expect(out.length, `size=${size} limit=${limit}`).toBeLessThanOrEqual(limit)
      }
    }
  })
})

describe("fitTelegramMessage", () => {
  const header = "🚨 <b>RPC Sentinel - CRITICAL</b>"

  it("reproduces the live failure and fixes it", () => {
    // 18 checks, with `Pipeline Silence` carrying a lane list the size of the
    // 09-10 outage. Unbounded this is what Telegram rejected.
    const checks = [
      { status: "critical", name: "Pipeline Silence", text: `🚨 Pipeline Silence: ${Array.from({ length: 40 }, (_, i) => `lane-${i} silent 813m (>60m, high)`).join("; ")}` },
      ...Array.from({ length: 17 }, (_, i) => line("warn", `Check ${i}`, 300)),
    ]
    const unbounded = `${header}\n\n${checks.map((c) => c.text).join("\n")}`
    expect(unbounded.length, "the fixture must actually reproduce the overflow").toBeGreaterThan(TELEGRAM_TEXT_LIMIT)

    const out = fitTelegramMessage(header, checks)
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
    // The CRITICAL is what the alert exists to convey; it survives.
    expect(out).toContain("Pipeline Silence")
    expect(out).toMatch(/checks omitted to fit Telegram/)
  })

  it("drops the least severe first — an ok is never kept at a critical's expense", () => {
    const checks = [
      line("ok", "Ok One", 1200),
      line("ok", "Ok Two", 1200),
      line("critical", "The Critical", 1200),
      line("warn", "A Warning", 1200),
    ]
    const out = fitTelegramMessage(header, checks)
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
    expect(out).toContain("The Critical")
    expect(out).toContain("A Warning")
    expect(out).not.toContain("Ok Two")
    expect(out).toMatch(/None of them was critical\./)
  })

  it("renders the kept lines in their ORIGINAL order, not severity order", () => {
    // Severity decides what SURVIVES; it must not decide what the reader sees
    // first, or the message stops matching the report it summarises.
    const checks = [line("ok", "Alpha", 10), line("critical", "Beta", 10), line("warn", "Gamma", 10)]
    const out = fitTelegramMessage(header, checks)
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Beta"))
    expect(out.indexOf("Beta")).toBeLessThan(out.indexOf("Gamma"))
  })

  it("NAMES any critical it was forced to drop", () => {
    // The one case where the notice has to do real work. A bare count here
    // would let a reader conclude they had seen every critical.
    const checks = Array.from({ length: 30 }, (_, i) => line("critical", `Crit ${i}`, 400))
    const out = fitTelegramMessage(header, checks)
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
    expect(out).toMatch(/INCLUDING \d+ CRITICAL: /)
    expect(out).toMatch(/Crit \d+/)
    expect(out).not.toMatch(/None of them was critical/)
  })

  it("caps a runaway single line instead of dropping the check entirely", () => {
    // A check's NAME and STATUS are worth more than its prose. One 50k-character
    // detail must not take the other seventeen checks down with it.
    const checks = [
      { status: "critical", name: "Huge", text: `Huge: ${"x".repeat(50_000)}` },
      ...Array.from({ length: 5 }, (_, i) => line("warn", `Small ${i}`, 50)),
    ]
    const out = fitTelegramMessage(header, checks)
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
    expect(out).toContain("Huge")
    expect(out).toContain("Small 0")
    expect(out).toMatch(/more characters omitted/)
  })

  it("adds no notice when everything fits", () => {
    const checks = [line("ok", "A", 10), line("warn", "B", 10)]
    const out = fitTelegramMessage(header, checks)
    expect(out).not.toMatch(/omitted/)
    expect(out).toContain("A")
    expect(out).toContain("B")
  })

  it("stays inside the limit for every shape, including a header that overflows alone", () => {
    const shapes: Array<[string, { status: string; name: string; text: string }[]]> = [
      ["empty", []],
      ["one tiny", [line("ok", "A", 1)]],
      ["many tiny", Array.from({ length: 200 }, (_, i) => line("ok", `C${i}`, 5))],
      ["many huge", Array.from({ length: 50 }, (_, i) => line("critical", `C${i}`, 2000))],
      ["mixed", [line("critical", "X", 5000), line("ok", "Y", 3), line("warn", "Z", 9000)]],
    ]
    for (const [label, checks] of shapes) {
      for (const h of [header, "H".repeat(TELEGRAM_TEXT_LIMIT + 500)]) {
        const out = fitTelegramMessage(h, checks)
        expect(out.length, `${label} / header ${h.length}`).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
      }
    }
  })
})

describe("the bound is enforced at the SENDER, so no caller can reintroduce it", () => {
  // The call site can always be copied without its length handling — that is how
  // this class spreads in this repo (recorded five times). The sender cannot be
  // bypassed, so that is where the ban lives. This case calls the real public
  // API with an over-long alert and reads what actually went on the wire.
  const bodies: string[] = []

  beforeEach(() => {
    bodies.length = 0
    process.env.TELEGRAM_BOT_TOKEN = "tg-token"
    process.env.TELEGRAM_CHAT_ID = "123"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        if (String(url).includes("api.telegram.org")) bodies.push(String(init?.body ?? ""))
        return { ok: true, status: 200, text: async () => "" } as any
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it("sendOpsAlert never puts an over-long text on the wire", async () => {
    vi.doMock("@/lib/supabase", () => ({
      supabaseAdmin: { rpc: async () => ({ data: true, error: null }) },
    }))
    const { sendOpsAlert } = await import("@/lib/ops-alert")

    await sendOpsAlert({ key: "bounded-test", subject: "RED", text: "w".repeat(20_000) })

    expect(bodies.length, "the telegram call must have happened").toBe(1)
    const sent = JSON.parse(bodies[0]).text as string
    expect(sent.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
    expect(sent).toMatch(/more characters omitted/)
  })
})
