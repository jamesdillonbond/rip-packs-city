import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { installOgCapture, resetOgCapture, ogText, type OgCapture } from "./helpers/og-capture"

// ─────────────────────────────────────────────────────────────────────────────
// /api/og/insights/candy-mlb — the empty-vs-unavailable honesty property.
//
// ── WHY THIS FILE EXISTS SEPARATELY ─────────────────────────────────────────
// The family guard, __tests__/api-og-insights-empty-vs-unavailable.test.ts,
// cannot cover this card. It selects its population with
// `includes("boardEmptyCopy(")` and drives every member by mocking
// `globalThis.fetch`. This card reads `supabaseAdmin` DIRECTLY and deliberately
// — a self-fetch would go back through proxy.ts and be 302'd to /login while
// the surface is launch-gated — so a fetch mock cannot drive it at all.
//
// ⭐ That is the durable point, and it was found the hard way (inbox
// 2026-08-26T1640Z): a convention enforced by a SHAPE silently excludes the
// cases that legitimately have a different shape, and the excluded case is
// exactly where the defect survived. Fifteen cards were hardened; the one card
// that could not join the guard kept the bug.
//
// ── THE DEFECT THIS PINS ────────────────────────────────────────────────────
// The route read `const { data } = await sb...`. supabase-js RESOLVES with
// `{ data: null, error }` rather than throwing, so a failed read never reached
// the `catch`, left the counters at null, and fell through to the SAME branch
// as a genuinely empty board — publishing "Live secondary FMV for the 2026 MLB
// Base Series" on a read that never happened. A claim of liveness is the worst
// thing to synthesise from a failure.
//
// 🚨 AND THE CARD'S OWN EXISTING TEST COULD NOT SEE IT. Its "when the view read
// fails" case mocks the limit() call THROWING — a failure mode supabase-js does
// not produce — so it proved the card survives something that cannot happen
// while being blind to the thing that does. It also asserted only that a PNG
// came back, never what the PNG SAID. Both halves are fixed here: the mock
// below returns the REAL `{ data: null, error }` shape, and the assertions are
// on rendered TEXT.
//
// ⚠ Assert the ABSENCE of the false claim, not merely the PRESENCE of an error
// string — a card that printed both would pass a presence-only check.
// ─────────────────────────────────────────────────────────────────────────────

const capture: { c: OgCapture | null } = { c: null }

/** The shape supabase-js ACTUALLY resolves with. `error` set => `data` null. */
function mockBoard(result: { data: Array<{ fmv_usd: number | null }> | null; error: unknown }) {
  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: {
      from: () => ({ select: () => ({ limit: async () => result }) }),
    },
  }))
}

async function renderText(): Promise<string> {
  const { GET } = await import("@/app/api/og/insights/candy-mlb/route")
  await GET()
  return ogText(capture.c!.element())
}

const LIVENESS_CLAIM = "Live secondary FMV"
const FAILURE_COPY = "Couldn't load the live board"

beforeEach(() => {
  resetOgCapture()
  capture.c = installOgCapture()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.resetModules()
  vi.doUnmock("@/lib/supabase")
  vi.restoreAllMocks()
  resetOgCapture()
})

describe("candy-mlb OG card distinguishes an empty board from an unreadable one", () => {
  it("a FAILED read does not claim liveness, and says it could not load", async () => {
    // The real supabase-js failure shape — resolved, not thrown.
    mockBoard({ data: null, error: { message: "canceling statement due to statement timeout" } })
    const text = await renderText()

    // The property, stated as an ABSENCE: this is what regressed.
    expect(
      text,
      "a read that failed must not publish a liveness claim it never measured",
    ).not.toContain(LIVENESS_CLAIM)
    expect(text).toContain(FAILURE_COPY)
    // It must not borrow the successful-read voice either.
    expect(text).not.toMatch(/\d+ of \d+ ICON editions/)
  })

  it("a SUCCESSFUL read with rows reports the measured counts", async () => {
    // The positive mirror. Without it a card hardwired to the failure copy
    // would pass the case above while lying in the common case.
    mockBoard({
      data: [
        ...Array.from({ length: 91 }, () => ({ fmv_usd: 4.22 })),
        ...Array.from({ length: 34 }, () => ({ fmv_usd: null })),
      ],
      error: null,
    })
    const text = await renderText()

    expect(text).toContain("91 of 125 ICON editions")
    expect(text).not.toContain(FAILURE_COPY)
  })

  it("a SUCCESSFUL read with ZERO rows is NOT reported as a failure", async () => {
    // The discrimination that matters: empty and unreadable are different
    // states and must not collapse into one branch in either direction.
    mockBoard({ data: [], error: null })
    const text = await renderText()

    expect(text).not.toContain(FAILURE_COPY)
    expect(text).not.toMatch(/\d+ of \d+ ICON editions/)
  })

  it("the harness can actually SEE the card's text (not vacuously passing)", async () => {
    // Every assertion above is a `not.toContain`, which passes for free against
    // an empty string. This proves the capture is really reading the element.
    mockBoard({ data: [{ fmv_usd: 1 }], error: null })
    const text = await renderText()
    expect(text.length).toBeGreaterThan(20)
    expect(text).toMatch(/ICON|MLB|Candy/i)
  })
})
