import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
// ⚠ THE shared stripper, never a fresh copy (CLAUDE.md): a hand-rolled one has
// twice blanked real source and reported a population while reading nothing.
// It is needed here because the FIX's own comment quotes the banned shape
// verbatim, so a raw-source grep flags the file that no longer has the defect.
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ── THE OPS ALERT PLANE MUST NOT BE MUTE BECAUSE AN ENV VAR IS UNSET ────────
//
// Measured 2026-09-18. `ALERT_EMAIL` is NOT set in the Vercel project (checked
// against the live env list: 58 keys, and it is not one of them), while
// `RESEND_API_KEY` IS set and `rippackscity.com` is a VERIFIED Resend sending
// domain. The sentinel's `sendEmail()` therefore returned `not_configured` on
// **18 of 18** recorded runs — and `lib/sentinel/alert-delivery.ts` records what
// that cost: on the one CRITICAL sweep that mattered, the single remaining
// channel returned `telegram-FAILED:http_400 … "message is too long"` and **the
// alarm reached nobody**.
//
// ⭐ THE DEFECT WAS AN INCONSISTENCY, NOT A MISSING VALUE, and that is why it is
// worth a ratchet rather than a one-line fix. THREE call sites read the same
// variable; exactly ONE carried a fallback and therefore worked, so the estate
// contained both the bug and its own cure and nothing compared them.
//
// ⛔ Do NOT satisfy this guard by setting ALERT_EMAIL in Vercel. An env var is
// the right way to CHANGE the recipient; it is not a floor, because the next
// project (or a reset) has it unset again and the channel goes mute silently.
// The property is: the OPS plane resolves a recipient with no env at all.
//
// ⚠ Deliberately scoped to the OPS plane. The per-user deal/FMV outbox in
// lib/alerts.ts sends to the USER's address — a fallback there would mail one
// person somebody else's alerts, which is the opposite of this fix.

const ROOT = process.cwd()
const OPS_PLANE = [
  "lib/ops-alert.ts",
  "app/api/sentinel/route.ts",
  "app/api/check-alerts/route.ts",
]

const read = (f: string) => readFileSync(join(ROOT, f), "utf8")
/** Source with comments blanked — see the import note. */
const code = (f: string) => stripComments(read(f)) as string

/**
 * `process.env.ALERT_EMAIL` with no NON-EMPTY `||`/`??` fallback after it.
 *
 * ⚠ The `[^"']+` is the whole point and the first draft of this guard omitted it.
 * The shape that actually shipped was `process.env.ALERT_EMAIL || ""` — it HAS a
 * fallback, and the fallback is the empty string, which is exactly as mute as no
 * fallback at all. A matcher that accepts any fallback passes the bug it was
 * written to catch, which the positive control below caught before this shipped.
 */
const BARE = /process\.env\.ALERT_EMAIL\s*(?!\s*(\|\||\?\?)\s*["'][^"']+["'])/

describe("the ops alert plane is never mute by default", () => {
  it("inspects the files it claims to — a bad path would pass vacuously", () => {
    // Population control. Without it, renaming any of these to a path that does
    // not exist would make every assertion below silently true.
    expect(OPS_PLANE.length).toBe(3)
    for (const f of OPS_PLANE) {
      expect(read(f).length).toBeGreaterThan(0)
      // ⚠ And that the STRIPPER did not blank it — a blind stripper reports a
      // population and reads nothing, which is the failure mode it was built for.
      expect(code(f).replace(/\s/g, "").length).toBeGreaterThan(200)
    }
  })

  it("exactly one place resolves the recipient, and it carries a fallback", () => {
    const src = code("lib/ops-alert.ts")
    expect(src).toMatch(/export const OPS_ALERT_EMAIL\s*=\s*process\.env\.ALERT_EMAIL\s*\|\|\s*["']/)
  })

  it("no ops-plane file reads process.env.ALERT_EMAIL bare", () => {
    const offenders = OPS_PLANE.filter((f) => {
      const src = code(f)
      // The one legitimate read is the fallback expression itself.
      const stripped = src.replace(
        /export const OPS_ALERT_EMAIL\s*=\s*process\.env\.ALERT_EMAIL\s*\|\|\s*["'][^"']+["']/,
        "",
      )
      return BARE.test(stripped)
    })
    expect(offenders).toEqual([])
  })

  it("POSITIVE CONTROL: the matcher catches the shape that shipped, and clears the fix", () => {
    // Quoted from the code as it stood before 2026-09-18.
    expect(BARE.test(`const ALERT_EMAIL = process.env.ALERT_EMAIL || "";`)).toBe(true)
    expect(BARE.test(`const ALERT_EMAIL = process.env.ALERT_EMAIL ?? "";`)).toBe(true)
    // …and accepts a real fallback, so the ban is not simply always-true.
    expect(BARE.test(`process.env.ALERT_EMAIL || "ops@example.com"`)).toBe(false)
    // ⭐ And the discriminator the first draft got wrong: an EMPTY fallback is
    // still mute, so it must be flagged. This arm is the reason the guard works.
    expect(BARE.test(`process.env.ALERT_EMAIL || ""`)).toBe(true)
  })

  it("the sentinel and check-alerts both consume the shared constant", () => {
    for (const f of ["app/api/sentinel/route.ts", "app/api/check-alerts/route.ts"]) {
      const src = code(f)
      expect(src).toMatch(/import\s*\{[^}]*OPS_ALERT_EMAIL[^}]*\}\s*from\s*["']@\/lib\/ops-alert["']/)
      expect(src).toMatch(/=\s*OPS_ALERT_EMAIL\b/)
    }
  })

  it("resolves a non-empty recipient with ALERT_EMAIL unset", async () => {
    // The behavioural half. The three arms above pin the SPELLING; this pins the
    // PROPERTY, which is the thing the sentinel's `!ALERT_EMAIL` branch tests.
    const prev = process.env.ALERT_EMAIL
    delete process.env.ALERT_EMAIL
    try {
      const mod = await import(`../lib/ops-alert?nofallbackcheck=${Date.now()}`)
      expect(typeof mod.OPS_ALERT_EMAIL).toBe("string")
      expect(mod.OPS_ALERT_EMAIL.length).toBeGreaterThan(0)
      expect(mod.OPS_ALERT_EMAIL).toContain("@")
    } finally {
      if (prev === undefined) delete process.env.ALERT_EMAIL
      else process.env.ALERT_EMAIL = prev
    }
  })

  it("NO-CHANGE CONTROL: the per-user outbox is NOT given a fallback", () => {
    // Without this, "add a fallback everywhere" passes the arms above and would
    // mail one person another user's alerts. The exclusion is asserted, not assumed.
    const src = code("lib/alerts.ts")
    expect(src).not.toMatch(/process\.env\.ALERT_EMAIL\s*\|\|/)
  })
})
