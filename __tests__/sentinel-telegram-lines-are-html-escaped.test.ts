import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { escapeTelegramHtml } from "@/lib/telegram-message"
import { renderSentinelTelegramLine } from "@/app/api/sentinel/route"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

/**
 * 🚨 OBSERVED LIVE 2026-09-19, 12:04 PM → 5:04 PM PT. Every sentinel Telegram
 * send in that window came back
 *
 *     telegram-FAILED:http_400: {"ok":false,"error_code":400,
 *       "description":"Bad Request: can't parse entities: Unsupported start tag \"\" at byte offset 3858"}
 *
 * The cause was not code. The `Cadence Collapse` acknowledgement reason, typed
 * into `sentinel_threshold_config.ack_reason` that morning, contained
 * `baseline_per_day < 400`. The ack pass prepends the reason to the check's
 * detail; the detail was interpolated RAW into a `parse_mode: "HTML"` message;
 * Telegram's parser read `< 4` as a tag with an empty name and rejected the
 * whole message. Email delivered, which is why the `Alert Delivery` arm could
 * see it at all.
 *
 * ⭐ THE CLASS: a check's detail is BUILT FROM DATA — ack reasons, lane names,
 * Postgres and upstream error strings — so the sender cannot rely on it being
 * markup-free, and a human writing a note cannot be expected to know that `<`
 * takes the pager down. The boundary escapes; the content does not have to.
 *
 * It is the same shape as the 2026-09-11 length rejection one file over: a
 * property of the CONTENT decided whether the alarm was heard, and the failure
 * showed up only as silence on that channel.
 */

// The literal substring from the ack reason that was live on 2026-09-19. Kept
// verbatim so this file reproduces the incident rather than an abstraction of it.
const LIVE_ACK_FRAGMENT =
  "FALSIFIER: if degraded_count is still >= 5 after this expiry with wallet-backfill baseline_per_day < 400, a caller HAS stopped again"

const emoji = (s: string) => (s === "ok" ? "✅" : s === "warn" ? "⚠️" : "🚨")

/**
 * Telegram's HTML parser, reduced to the one property that matters here: after
 * removing the tags WE emit, no `<` may remain. A `<` followed by anything other
 * than a tag Telegram knows is a hard reject, and the sentinel only ever emits
 * `<b>…</b>` around a name.
 */
function strayAngleBrackets(text: string): string[] {
  return text.replace(/<\/?b>/g, "").match(/</g) ?? []
}

describe("escapeTelegramHtml", () => {
  it("escapes the three characters Telegram documents as requiring it", () => {
    expect(escapeTelegramHtml(`a < b > c & d`)).toBe("a &lt; b &gt; c &amp; d")
  })

  it("is a no-op on text that carries none of them (negative control)", () => {
    const plain = "daily-portfolio-snapshot 0/1 ok, 0 rows — canceling statement due to statement timeout"
    expect(escapeTelegramHtml(plain)).toBe(plain)
  })

  it("escapes `&` FIRST, so an already-escaped entity is not double-decoded on the way back", () => {
    // If `<` were escaped before `&`, "&lt;" would become "&amp;lt;" — wrong in
    // the other direction. Order is load-bearing and this pins it.
    expect(escapeTelegramHtml("&lt;")).toBe("&amp;lt;")
    expect(escapeTelegramHtml("<")).toBe("&lt;")
  })

  it("tolerates null/undefined the way a detail built from a failed read can be", () => {
    expect(escapeTelegramHtml(null)).toBe("")
    expect(escapeTelegramHtml(undefined)).toBe("")
  })
})

describe("renderSentinelTelegramLine", () => {
  it("POSITIVE CONTROL: the raw 2026-09-19 interpolation really does leave a stray `<`", () => {
    // This is the line the handler used to build, byte for byte. If this ever
    // stops producing a stray bracket the incident could not recur and the rest
    // of this file is proving nothing — so it is asserted, not assumed.
    const raw = `${emoji("warn")} <b>Cadence Collapse</b>: [ACKNOWLEDGED until 2026-10-01 — ${LIVE_ACK_FRAGMENT}] 7 lanes`
    expect(strayAngleBrackets(raw)).toHaveLength(1)
  })

  it("escapes the live 2026-09-19 ack reason so the line carries no stray `<`", () => {
    const line = renderSentinelTelegramLine(
      {
        status: "warn",
        name: "Cadence Collapse",
        detail: `[ACKNOWLEDGED until 2026-10-01 — ${LIVE_ACK_FRAGMENT}] 7 lanes`,
      },
      emoji,
    )
    expect(strayAngleBrackets(line)).toHaveLength(0)
    expect(line).toContain("baseline_per_day &lt; 400")
    // The markup WE add must survive — escaping the whole line would turn the
    // bold name into literal text and make every alert harder to scan.
    expect(line).toMatch(/^⚠️ <b>Cadence Collapse<\/b>: /)
  })

  it("escapes the NAME as well as the detail — a check name is a value too", () => {
    const line = renderSentinelTelegramLine({ status: "critical", name: "x < y", detail: "d" }, emoji)
    expect(line).toBe("🚨 <b>x &lt; y</b>: d")
  })

  it("leaves a line with nothing to escape byte-identical to the old shape (no-change control)", () => {
    const c = {
      status: "ok",
      name: "Sales Ingest by Collection",
      detail: "Top Shot 1976/24h (last 0.3h ago) · All Day 387/24h",
    }
    expect(renderSentinelTelegramLine(c, emoji)).toBe(`${emoji(c.status)} <b>${c.name}</b>: ${c.detail}`)
  })
})

describe("the sentinel handler uses the escaping line builder, not a raw template", () => {
  // Structural pin. A helper existing is not the same as the sender using it —
  // the 2026-09-12 Telegram-bound guard found nine senders that had not adopted
  // a helper written for exactly their defect. So the call site is asserted.
  const src = stripComments(readFileSync(join(process.cwd(), "app/api/sentinel/route.ts"), "utf8"))

  it("builds every per-check Telegram line through renderSentinelTelegramLine", () => {
    expect(src).toMatch(/text:\s*renderSentinelTelegramLine\(c,\s*emoji\)/)
  })

  it("no longer interpolates a check's detail raw into a `<b>` line", () => {
    // The exact pre-fix shape. Its absence is the whole fix.
    expect(src).not.toMatch(/<b>\$\{c\.name\}<\/b>:\s*\$\{c\.detail\}/)
  })

  it("escapes the header's change line, which carries check names and a failure reason", () => {
    expect(src).toMatch(/\$\{escapeTelegramHtml\(changeLine\)\}/)
  })
})
