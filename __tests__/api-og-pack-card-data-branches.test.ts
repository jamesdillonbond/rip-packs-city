import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { installOgCapture, resetOgCapture, ogText, usesColor, type OgCapture } from "./helpers/og-capture"

// Per-card DATA-BRANCH test for /api/og/pack — 36.0% branch coverage before this
// landed (80 of 125 branches uncovered), the largest single block of untested
// branches among the OG cards.
//
// This is the OG card with the most consequential logic in the estate, because it
// publishes a VERDICT: a green "+EV" badge on a social unfurl is a buy signal
// reaching people who never open the page. Two guards decide whether that badge is
// honest, and neither had a test:
//
//  1. THE SURVIVOR-BIAS GUARD. A depleted Top Shot pack's drop pool retains only
//     its rare chases, so raw gross EV inflates 40–86× (measured: dist 5223 shows
//     "Gross EV $801 · 80x" on a $10 pack). Rendering that as a green +EV card is
//     the single worst thing this route can do. It is suppressed when the pool is
//     ≥90% depleted OR gross EV exceeds 3× a live secondary ask.
//
//  2. THE VERDICT ANCHOR. Net / ratio / +EV compare gross EV ONLY to the live
//     secondary ask — what a sealed pack actually resells for — never to retail.
//     With no ask there is no verdict, and the card must say NO ASK rather than
//     quietly anchoring on the primary price and inventing one.
//
// All Day is exempt from guard 1 because its odds-corrected EV already replaces
// the inflated canonical number; that exemption is asserted too, since applying
// the guard to All Day would blank a figure that is correct.

const capture: { c: OgCapture | null } = { c: null }

type Row = Record<string, unknown> | null

function mockDb(opts: { pack?: Row; packError?: boolean; corrected?: Row; noEnv?: boolean; throws?: boolean }) {
  if (opts.noEnv) {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "")
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "")
  } else {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://db.test")
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
  }
  vi.doMock("@supabase/supabase-js", () => ({
    createClient: () => ({
      from: (table: string) => {
        const b: Record<string, unknown> = {}
        for (const m of ["select", "eq", "limit"]) b[m] = () => b
        b.maybeSingle = async () => {
          // supabase-js RETURNS Postgrest errors but THROWS on a transport
          // failure; an uncaught throw 500s the card into an empty unfurl.
          if (opts.throws) throw new Error("socket hang up")
          return table === "v_allday_pack_detail_ev"
            ? { data: opts.corrected ?? null, error: null }
            : { data: opts.pack ?? null, error: opts.packError ? { message: "timeout" } : null }
        }
        return b
      },
    }),
  }))
}

async function render(query: string) {
  const { GET } = await import("@/app/api/og/pack/route")
  await GET(new NextRequest(`https://www.rippackscity.com/api/og/pack${query}`))
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

/** A healthy Top Shot pack: live ask $20, $60 of value still sealed → +EV 3.00x. */
const HEALTHY = {
  title: "Series 5 Common Pack",
  tier: "common",
  retail_price_usd: 10,
  gross_ev: 60,
  ev_depletion_pct: 20,
  secondary_ask: 20,
  secondary_available: true,
  depletion_pct: 55,
  collection_slug: "nba_top_shot",
}

const TS = "?distId=5020&collection=nba-top-shot"

describe("/api/og/pack — the verdict", () => {
  it("renders a +EV verdict with the ratio when value beats the live ask", async () => {
    mockDb({ pack: HEALTHY })
    const el = await render(TS)
    const text = ogText(el)

    expect(text).toContain("Series 5 Common Pack")
    expect(text).toContain("SECONDARY ASK")
    expect(text).toContain("$20.00")
    expect(text).toContain("VALUE SEALED")
    expect(text).toContain("$60.00")
    expect(text).toContain("3.00x")
    expect(text).toContain("+EV")
    expect(text).toContain("55% sealed packs sold")
    expect(usesColor(el, "#10B981")).toBe(true) // the green verdict
  })

  it("renders −EV when the sealed value is below the ask", async () => {
    mockDb({ pack: { ...HEALTHY, gross_ev: 5 } })
    const el = await render(TS)
    expect(ogText(el)).toContain("−EV")
    expect(usesColor(el, "#EF4444")).toBe(true)
  })

  // ── Guard 1: survivor bias ────────────────────────────────────────────────

  it("SUPPRESSES the EV on a ≥90%-depleted pool instead of publishing an inflated +EV", async () => {
    // The dist-5223 shape: a $10 pack whose remaining pool prices at $801.
    mockDb({
      pack: { ...HEALTHY, gross_ev: 801, ev_depletion_pct: 96, secondary_ask: 10 },
    })
    const text = ogText(await render(TS))

    expect(text).toContain("EV N/A")
    expect(text).not.toContain("+EV")
    expect(text).not.toContain("$801")
    // The ratio must go too — an "80.10x" beside a suppressed figure is worse
    // than either alone.
    expect(text).not.toContain("80.10x")
  })

  it("SUPPRESSES the EV when gross EV exceeds 3x the live ask, even on a shallow pool", async () => {
    // The second arm of the guard. 10% depleted, so only the ratio test fires.
    mockDb({
      pack: { ...HEALTHY, gross_ev: 100, ev_depletion_pct: 10, secondary_ask: 10 },
    })
    const text = ogText(await render(TS))
    expect(text).toContain("EV N/A")
    expect(text).not.toContain("10.00x")
  })

  it("does NOT fire at exactly 3x — the boundary is strict", async () => {
    // Positive mirror for the ratio arm: 3x is the documented threshold, and a
    // guard that also swallowed the boundary would blank honest cards.
    mockDb({ pack: { ...HEALTHY, gross_ev: 60, ev_depletion_pct: 10, secondary_ask: 20 } })
    const text = ogText(await render(TS))
    expect(text).toContain("+EV")
    expect(text).toContain("3.00x")
  })

  it("fires at exactly 90% depletion — that boundary is inclusive", async () => {
    mockDb({ pack: { ...HEALTHY, ev_depletion_pct: 90, gross_ev: 21, secondary_ask: 20 } })
    expect(ogText(await render(TS))).toContain("EV N/A")
  })

  it("EXEMPTS All Day's odds-corrected EV from the survivor-bias guard", async () => {
    // The corrected figure already replaces the inflated canonical one, so
    // applying the guard here would blank a number that is correct. This is the
    // branch that makes the exemption meaningful: depletion is 96%, which would
    // otherwise suppress.
    mockDb({
      pack: { ...HEALTHY, collection_slug: "nfl_all_day", ev_depletion_pct: 96, gross_ev: 430 },
      corrected: { corrected_gross_ev: 12, corrected_net_ev: -8, corrected_value_ratio: 0.6 },
    })
    const text = ogText(await render("?distId=1&collection=nfl-all-day"))

    expect(text).toContain("$12.00") // the corrected value, shown
    expect(text).not.toContain("$430") // the inflated canonical one, never
    expect(text).not.toContain("EV N/A")
    expect(text).toContain("−EV") // 12 < 20 ask
  })

  it("keeps the canonical EV when the corrected view has nothing for this dist", async () => {
    mockDb({
      pack: { ...HEALTHY, collection_slug: "nfl_all_day" },
      corrected: { corrected_gross_ev: null },
    })
    const text = ogText(await render("?distId=1&collection=nfl-all-day"))
    // No correction available → the guard is back in force and the raw number
    // is used, so this must NOT silently claim to be corrected.
    expect(text).toContain("$60.00")
  })

  // ── Guard 2: the verdict anchor ───────────────────────────────────────────

  it("shows NO ASK — never a retail-anchored verdict — when there is no live ask", async () => {
    mockDb({ pack: { ...HEALTHY, secondary_available: false, secondary_ask: null } })
    const text = ogText(await render(TS))

    expect(text).toContain("NO ASK")
    expect(text).toContain("RETAIL")
    expect(text).toContain("$10.00")
    expect(text).not.toContain("+EV")
    // Gross EV is still shown informationally; only the VERDICT is withheld.
    expect(text).toContain("$60.00")
  })

  it.each([
    ["the flag is false", { secondary_available: false, secondary_ask: 20 }],
    ["the ask is zero", { secondary_available: true, secondary_ask: 0 }],
    ["the ask is null", { secondary_available: true, secondary_ask: null }],
  ])("treats %s as no anchor at all", async (_l, patch) => {
    mockDb({ pack: { ...HEALTHY, ...patch } })
    const text = ogText(await render(TS))
    expect(text).toContain("NO ASK")
    expect(text).not.toContain("3.00x")
  })

  // ── Tier accent + formatting ──────────────────────────────────────────────

  it.each([
    ["legendary", "#FFD700"],
    ["rare", "#A855F7"],
    ["fandom", "#3B82F6"],
    ["moment_tier_ultimate", "#FFD700"],
  ])("maps tier %s to its accent", async (tier, hex) => {
    mockDb({ pack: { ...HEALTHY, tier } })
    expect(usesColor(await render(TS), hex)).toBe(true)
  })

  it("falls back to the common accent for an unmapped tier", async () => {
    mockDb({ pack: { ...HEALTHY, tier: "mythic" } })
    expect(usesColor(await render(TS), "#9CA3AF")).toBe(true)
  })

  it("rounds figures at or above $100 and keeps cents below it", async () => {
    mockDb({ pack: { ...HEALTHY, gross_ev: 1234.56, secondary_ask: 99.5 } })
    const text = ogText(await render(TS))
    expect(text).toContain("$99.50")
    // >= 100 → thousands-separated whole dollars. (Ratio here is 12.4x, above
    // the 3x guard, so the value itself is suppressed — assert the ask only.)
    expect(text).not.toContain("$1234.56")
  })

  // ── Fallback branches ─────────────────────────────────────────────────────

  it.each([
    ["no distId", "?collection=nba-top-shot", {}],
    ["a dist with no row", "?distId=9999", { pack: null }],
    ["a failed query", "?distId=9999", { packError: true }],
    ["missing service-role env", "?distId=9999", { noEnv: true, pack: HEALTHY }],
    // ⚠ A THROWN client, not a returned error. Without a catch in fetchPack this
    // escapes GET and 500s the route — no PNG at all, which is a blank unfurl.
    ["a thrown transport failure", "?distId=9999", { throws: true }],
  ])("renders the generic Pack card for %s", async (_l, query, opts) => {
    mockDb(opts as never)
    const text = ogText(await render(query))

    expect(text).toContain("Pack")
    expect(text).toContain("PACK EV")
    // No verdict may be asserted from a row we never read.
    expect(text).not.toContain("+EV")
    expect(text).not.toContain("Series 5 Common Pack")
    // Depletion is unknown → the neutral provenance line, not "null% sold".
    expect(text).toContain("Cached snapshot via Rip Packs City")
    expect(text).not.toContain("null%")
  })

  it("always renders at 1200x630", async () => {
    mockDb({ pack: HEALTHY })
    await render(TS)
    expect(capture.c!.options()).toMatchObject({ width: 1200, height: 630 })
  })
})

// ── Guard 3 (2026-09-03): freshness ─────────────────────────────────────────
//
// `secondary_available` and `secondary_ask` are columns on the pack_ev_latest
// snapshot, so the verdict anchor is exactly as fresh as `ev_snapshotted_at`.
// The pack page and the deals surface already suppress the verdict past the
// shared 72 h bar (EV_SNAPSHOT_MAX_AGE_HOURS); this card did not, and the unfurl
// is the one surface with no methodology footnote to carry the age. Measured
// 2026-09-03: 654 of 1,210 Top Shot rows over three days old still carried
// secondary_available, 22 of them is_positive_ev, the oldest 135 days.
describe("/api/og/pack — the freshness gate", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString()

  it("SUPPRESSES the verdict and the sealed value on a snapshot older than the 72 h bar", async () => {
    // Four days old: the page would already refuse to headline this. The row is
    // otherwise the HEALTHY +EV shape, so only the age can be what flips it.
    mockDb({ pack: { ...HEALTHY, ev_snapshotted_at: hoursAgo(96) } })
    const el = await render(TS)
    const text = ogText(el)

    expect(text).toContain("EV STALE")
    expect(text).not.toContain("+EV")
    expect(text).not.toContain("3.00x")
    expect(text).not.toContain("$60.00")
    expect(usesColor(el, "#10B981")).toBe(false)
  })

  it("keeps the verdict on a snapshot inside the bar — the gate is about age, not the column's presence", async () => {
    mockDb({ pack: { ...HEALTHY, ev_snapshotted_at: hoursAgo(2) } })
    const el = await render(TS)
    const text = ogText(el)

    expect(text).toContain("+EV")
    expect(text).toContain("3.00x")
    expect(text).not.toContain("EV STALE")
    expect(usesColor(el, "#10B981")).toBe(true)
  })

  it("staleness is judged BEFORE survivor bias — a stale, depleted pool says STALE, not N/A", async () => {
    // Both gates trip. The page's rule: when the snapshot is days old, "survivor
    // bias" is the wrong explanation to give the reader.
    mockDb({ pack: { ...HEALTHY, gross_ev: 801, ev_depletion_pct: 96, secondary_ask: 10, ev_snapshotted_at: hoursAgo(96) } })
    const text = ogText(await render(TS))
    expect(text).toContain("EV STALE")
    expect(text).not.toContain("EV N/A")
  })
})
