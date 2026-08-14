import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { installOgCapture, resetOgCapture, ogText, usesColor, type OgCapture } from "./helpers/og-capture"

// DATA-BRANCH tests for /api/og/pack/lifecycle — 56.8% branch with 51 uncovered,
// the largest single gap left among the OG cards after the others were covered.
//
// This card publishes a per-pack ROI VERDICT (+ROI / −ROI) onto a social unfurl,
// which is the same "a number reaching people who never open the page" exposure
// as the sibling /api/og/pack EV card. Three things decide whether that verdict
// is honest, and none were tested:
//
//  1. It must only appear for a RIPPED pack. A sealed pack has pulled nothing,
//     so a profit figure for it would be fiction.
//  2. It needs BOTH a gross pull value and a cost BASIS. Retail is a display
//     anchor only — deriving ROI from retail when the real basis is unknown
//     invents a cost the holder never paid.
//  3. A pack the RPC could not resolve must fall back to a neutral card, never
//     to a verdict computed from partial data.

const capture: { c: OgCapture | null } = { c: null }

function mockDb(opts: { lifecycle?: unknown; error?: boolean; noEnv?: boolean; throws?: boolean }) {
  if (opts.noEnv) {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "")
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "")
  } else {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://db.test")
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
  }
  vi.doMock("@supabase/supabase-js", () => ({
    createClient: () => ({
      rpc: async () => {
        if (opts.throws) throw new Error("connection reset")
        return opts.error
          ? { data: null, error: { message: "timeout" } }
          : { data: opts.lifecycle ?? null, error: null }
      },
    }),
  }))
}

async function render(query: string) {
  const { GET } = await import("@/app/api/og/pack/lifecycle/route")
  await GET(new NextRequest(`https://www.rippackscity.com/api/og/pack/lifecycle${query}`))
  return capture.c!.element()
}

beforeEach(() => {
  resetOgCapture()
  capture.c = installOgCapture()
})

afterEach(() => {
  vi.resetModules()
  vi.doUnmock("@supabase/supabase-js")
  vi.unstubAllEnvs()
  resetOgCapture()
})

/** A ripped pack that made money: $120 pulled against a $40 basis. */
const RIPPED = {
  status: "ripped",
  pack_name: "Fallback Name",
  distribution: {
    title: "Series 5 Rare Pack",
    tier: "rare",
    depletion_pct: 72,
    retail_price_usd: 25,
  },
  stats: { total_cost_basis: 40, currency: "DUC", gross_pull_value_usd: 120 },
  pulls: [
    { player_name: "Damian Lillard", tier: "legendary", current_fmv: 90 },
    { player_name: "Anfernee Simons", tier: "rare", current_fmv: 20 },
    { player_name: "Deandre Ayton", tier: "common", current_fmv: 10 },
    { player_name: "Fourth Guy", tier: "common", current_fmv: 5 },
  ],
}

const ID = "?id=12345"

describe("/api/og/pack/lifecycle — the ROI verdict", () => {
  it("renders +ROI with the pulled value and the delta for a profitable rip", async () => {
    mockDb({ lifecycle: RIPPED })
    const el = await render(ID)
    const text = ogText(el)

    expect(text).toContain("Series 5 Rare Pack")
    expect(text).toContain("PACK RIP")
    expect(text).toContain("PULLED")
    // ⚠ fmtUsd ROUNDS at >= 100 — "$120", not "$120.00". Asserted against the
    // formatter in this file rather than the sibling og/pack card's, which has
    // its own threshold; guessing it is how the first draft of this test failed.
    expect(text).toContain("$120")
    // The ripped path labels the anchor PAID; LAST BOUGHT / RETAIL are the
    // SEALED path's labels.
    expect(text).toContain("PAID")
    expect(text).toContain("$40.00")
    expect(text).toContain("VS COST")
    expect(text).toContain("+ROI")
    expect(text).toContain("+$80.00")
    expect(text).toContain("72% sealed packs sold")
    expect(usesColor(el, "#10B981")).toBe(true)
  })

  it("renders −ROI, and signs the delta with a minus rather than a hyphen", async () => {
    mockDb({
      lifecycle: { ...RIPPED, stats: { ...RIPPED.stats, gross_pull_value_usd: 10 } },
    })
    const el = await render(ID)
    const text = ogText(el)
    expect(text).toContain("−ROI")
    expect(text).toContain("−$30.00")
    expect(usesColor(el, "#EF4444")).toBe(true)
  })

  it("shows a break-even rip as −ROI rather than positive", async () => {
    // delta === 0 is not a profit. `isPositive` is `> 0`, so the boundary must
    // fall on the honest side.
    mockDb({ lifecycle: { ...RIPPED, stats: { ...RIPPED.stats, gross_pull_value_usd: 40 } } })
    expect(ogText(await render(ID))).toContain("−ROI")
  })

  // ── Verdict gate 1: only a ripped pack ────────────────────────────────────

  it("a SEALED pack gets no ROI verdict — it has pulled nothing", async () => {
    mockDb({ lifecycle: { ...RIPPED, status: "sealed" } })
    const text = ogText(await render(ID))

    expect(text).toContain("SEALED PACK")
    expect(text).toContain("SEALED")
    expect(text).not.toContain("ROI")
    expect(text).not.toContain("PULLED")
    // The cost anchor is still shown informationally.
    expect(text).toContain("$40.00")
  })

  it("an UNKNOWN status is not treated as resolved", async () => {
    mockDb({ lifecycle: { ...RIPPED, status: "unknown" } })
    const text = ogText(await render(ID))
    expect(text).not.toContain("ROI")
    expect(text).not.toContain("PACK RIP")
  })

  it("a payload carrying an error field is not treated as resolved", async () => {
    // The RPC can answer 200 with `{ error: ... }`; reading only `status` would
    // render a verdict from a payload that told us not to trust it.
    mockDb({ lifecycle: { ...RIPPED, error: "not indexed" } })
    const text = ogText(await render(ID))
    expect(text).not.toContain("+ROI")
    expect(text).not.toContain("PACK RIP")
  })

  // ── Verdict gate 2: a real cost basis, never retail ───────────────────────

  it("withholds the verdict when the cost BASIS is unknown, even though retail exists", async () => {
    // This is the sharpest of the three. Retail is a display anchor; deriving
    // ROI from it would invent a cost the holder never paid — the pack may have
    // been bought on secondary at any price.
    mockDb({
      lifecycle: { ...RIPPED, stats: { ...RIPPED.stats, total_cost_basis: null } },
    })
    const text = ogText(await render(ID))

    expect(text).toContain("RIPPED") // still a rip...
    expect(text).not.toContain("ROI") // ...with no verdict
    expect(text).not.toContain("VS COST") // ...and no delta stat at all
    // Retail silently takes over as the PAID anchor. ⚠ Worth knowing: on the
    // ripped path the label stays "PAID" either way, so a reader cannot tell a
    // real basis from a retail stand-in. That is a labelling weakness rather
    // than a false number, and it is pinned here so a future edit is deliberate.
    expect(text).toContain("PAID")
    expect(text).toContain("$25.00")
    // The pulled value is still honest and still shown.
    expect(text).toContain("$120")
  })

  it("withholds the verdict when the gross pull value is unknown", async () => {
    mockDb({
      lifecycle: { ...RIPPED, stats: { ...RIPPED.stats, gross_pull_value_usd: null } },
    })
    const text = ogText(await render(ID))
    expect(text).toContain("RIPPED")
    expect(text).not.toContain("+ROI")
    expect(text).not.toContain("−ROI")
  })

  it("coerces numeric STRINGS from PostgREST", async () => {
    // numeric columns arrive as strings; left uncoerced the delta would
    // concatenate instead of subtract.
    mockDb({
      lifecycle: {
        ...RIPPED,
        stats: { total_cost_basis: "40", currency: "DUC", gross_pull_value_usd: "120" },
      },
    })
    expect(ogText(await render(ID))).toContain("+$80.00")
  })

  // ── Pulls ─────────────────────────────────────────────────────────────────

  it("shows the top 3 pulls by FMV, highest first", async () => {
    mockDb({ lifecycle: RIPPED })
    const text = ogText(await render(ID))
    expect(text).toContain("Damian Lillard")
    expect(text).toContain("Anfernee Simons")
    expect(text).toContain("Deandre Ayton")
    // Capped at 3 — the fourth must not appear.
    expect(text).not.toContain("Fourth Guy")
    expect(text.indexOf("Damian Lillard")).toBeLessThan(text.indexOf("Anfernee Simons"))
  })

  it("renders no pull list for an unresolved pack", async () => {
    mockDb({ lifecycle: { ...RIPPED, status: "unknown" } })
    expect(ogText(await render(ID))).not.toContain("Damian Lillard")
  })

  // ── Title + tier fallbacks ────────────────────────────────────────────────

  it("falls back to pack_name when the distribution has no title", async () => {
    mockDb({ lifecycle: { ...RIPPED, distribution: null } })
    const text = ogText(await render(ID))
    expect(text).toContain("Fallback Name")
    expect(text).toContain("Pack") // the tier label degrades too
  })

  it("falls back to the pack id when neither title nor name resolves", async () => {
    mockDb({ lifecycle: { ...RIPPED, distribution: null, pack_name: null } })
    expect(ogText(await render(ID))).toContain("Pack #12345")
  })

  it.each([
    ["legendary", "#FFD700"],
    ["rare", "#A855F7"],
    ["moment_tier_fandom", "#3B82F6"],
  ])("maps tier %s to its accent", async (tier, hex) => {
    mockDb({ lifecycle: { ...RIPPED, distribution: { ...RIPPED.distribution, tier } } })
    expect(usesColor(await render(ID), hex)).toBe(true)
  })

  // ── Fallback branches ─────────────────────────────────────────────────────

  it.each([
    ["no id", "", {}],
    ["an unresolvable id", ID, { lifecycle: null }],
    ["a failed query", ID, { error: true }],
    ["a thrown client", ID, { throws: true }],
    ["missing service-role env", ID, { noEnv: true, lifecycle: RIPPED }],
  ])("renders a neutral card for %s — never a verdict", async (_l, query, opts) => {
    mockDb(opts as never)
    const text = ogText(await render(query))

    expect(text).toContain("Pack")
    expect(text).not.toContain("ROI")
    expect(text).not.toContain("Series 5 Rare Pack")
    // Depletion is unknown → the neutral provenance line, not "null% sold".
    expect(text).toContain("Pack lifecycle via Rip Packs City")
    expect(text).not.toContain("null%")
  })

  it("always renders at 1200x630", async () => {
    mockDb({ lifecycle: RIPPED })
    await render(ID)
    expect(capture.c!.options()).toMatchObject({ width: 1200, height: 630 })
  })
})
