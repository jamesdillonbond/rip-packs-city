import { describe, it, expect } from "vitest"
import { summarizeSentinelChange, formatPT } from "@/app/api/sentinel/route"

// The sentinel's overall status is `checks.some(c => c.status === "warn")`, and
// measured over the 21 runs in retention on 2026-09-13 it was WARN or CRITICAL
// on EVERY ONE, never fewer than 4 warn arms. So the status word is a constant
// and the changed SET is the only thing in the header that carries information.
const ok = (name: string) => ({ name, status: "ok" })
const warn = (name: string) => ({ name, status: "warn" })
const crit = (name: string) => ({ name, status: "critical" })

describe("summarizeSentinelChange", () => {
  it("NAMES an arm that was not warning on the previous sweep", () => {
    const out = summarizeSentinelChange([warn("Dune Spend"), warn("Sniper Feed"), ok("Sales Ingest")], {
      ok: true,
      names: ["Dune Spend"],
      at: "2026-09-13T05:13:00Z",
    })
    expect(out).toContain("NEW: Sniper Feed")
    expect(out).not.toContain("Dune Spend")
  })

  it("NAMES an arm that stopped warning", () => {
    const out = summarizeSentinelChange([warn("Dune Spend")], {
      ok: true,
      names: ["Dune Spend", "Edition Coverage"],
      at: "2026-09-13T05:13:00Z",
    })
    expect(out).toContain("cleared: Edition Coverage")
  })

  // ⭐ THE DISCRIMINATOR THIS EXISTS FOR. Both sweeps have EXACTLY 8 non-ok arms,
  // so any count-shaped summary reports "no change" while the membership turned
  // over — the documented "diff the SET, not the count" failure, here inside an
  // alarm. A summary that cannot pass this is not worth shipping.
  it("reports a full turnover that leaves the COUNT identical", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"]
    const after = ["a", "b", "c", "d", "e", "f", "g", "ZZZ"]
    const out = summarizeSentinelChange(after.map(warn), {
      ok: true,
      names: before,
      at: "2026-09-13T05:13:00Z",
    })
    expect(out).toContain("NEW: ZZZ")
    expect(out).toContain("cleared: h")
    expect(out).not.toMatch(/no change/)
  })

  it("says 'no change' only when the SET is genuinely identical", () => {
    const out = summarizeSentinelChange([warn("Dune Spend"), crit("Trust Health")], {
      ok: true,
      names: ["Trust Health", "Dune Spend"], // same set, different order
      at: "2026-09-13T05:13:00Z",
    })
    expect(out).toMatch(/^no change since /)
  })

  // 🚨 THE HONESTY PROPERTY. A failed read of the previous sweep must render as
  // unavailable. "no change" is a CLAIM ABOUT THE FLEET, and publishing it out of
  // a failed read is this repo's most productive defect class committed inside
  // the alarm that is supposed to catch it. Asserts the ABSENCE of the false
  // claim, not merely the presence of the word "unavailable".
  it.each([
    ["read failed: canceling statement due to statement timeout"],
    ["no earlier sweep in retention"],
    ["earlier sweep stored no check names"],
  ])("NEVER renders a failed previous-run read as 'no change' (%s)", (reason) => {
    const out = summarizeSentinelChange([warn("Dune Spend")], { ok: false, reason })
    expect(out).not.toMatch(/no change/)
    expect(out).not.toMatch(/NEW:/)
    expect(out).not.toMatch(/cleared:/)
    expect(out).toContain("UNAVAILABLE")
    expect(out).toContain(reason)
  })

  it("an all-clear sweep after a dirty one names everything that cleared", () => {
    const out = summarizeSentinelChange([ok("Dune Spend"), ok("Trust Health")], {
      ok: true,
      names: ["Dune Spend", "Trust Health"],
      at: "2026-09-13T05:13:00Z",
    })
    expect(out).toContain("cleared: Dune Spend, Trust Health")
  })

  // The header is never dropped by fitTelegramMessage, so an unbounded name list
  // would eat the budget the per-check lines need. Passed explicitly because no
  // realistic fixture has 7+ simultaneously-new arms — the cap was untestable
  // through a default-only call, which is the same trap buildSentinelFindings hit.
  it("caps the names it lists and declares the remainder", () => {
    const after = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]
    const out = summarizeSentinelChange(after.map(warn), { ok: true, names: [], at: null }, 3)
    expect(out).toContain("NEW: n1, n2, n3 +5 more")
    expect(out).not.toContain("n4")
  })
})

describe("formatPT", () => {
  // CLAUDE.md, emphatic and repeatedly broken: every time this estate reports to
  // Trevor it is PT. This string is the header of a Telegram he reads at 3am.
  it("renders PT and never a UTC/Z time", () => {
    const out = formatPT("2026-09-13T05:13:00Z") // 22:13 PT on 09-12
    expect(out).toContain("PT")
    expect(out).toContain("10:13")
    expect(out).toContain("Sep 12")
    expect(out).not.toMatch(/\bGMT\b|\bUTC\b|Z$/)
  })

  it("does not invent a time it does not have", () => {
    expect(formatPT(null)).toBe("unknown time")
    expect(formatPT("not-a-date")).toBe("unknown time")
  })
})
