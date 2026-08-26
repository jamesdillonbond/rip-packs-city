// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// Behaviour half of the baked-population-count fix. The sibling ratchet
// (`insights-copy-has-no-baked-population-counts`) proves no LITERAL survives in
// the tree; this proves the replacements are HONEST — that a failed or absent
// read drops the number instead of publishing a fabricated one.
//
// ⚠ PINNED ON THE PROPERTY, NOT THE COPY. The assertions are "no digit-shaped
// population claim appears" and "the string never says 0 wallets", not an exact
// sentence. Wording on these boards changes; the contract does not. Asserting
// the sentence would go red on a harmless edit and — worse — would pass if
// someone reworded a fabricated zero.
//
// ⚠ AND BOTH DIRECTIONS ARE COVERED. A guard that only checks "never shows a
// number on failure" is satisfied by a component that never shows the number at
// all, which would silently delete a true claim. Each case therefore has a
// no-change control asserting the real count still renders when it is readable.

const cohortState = vi.hoisted(() => ({ count: null as number | null, error: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: async () => ({ count: cohortState.count, error: cohortState.error }),
    }),
  },
}))

vi.mock("@/lib/seo", () => ({ TWITTER_INHERITED: { site: "@RipPacksCity" } }))

const { generateMetadata } = await import("@/app/insights/cross-collection/layout")
const CrossCollectionBoardClient = (
  await import("@/app/insights/cross-collection/CrossCollectionBoardClient")
).default
const SqueezeBoardClient = (await import("@/app/insights/squeeze/SqueezeBoardClient")).default

/** Any "<digits> wallets/editions" claim, which is exactly what must not be fabricated. */
const POPULATION_CLAIM = /\b\d[\d,]*\s+(wallets|editions)\b/i

function metadataStrings(m: Record<string, unknown>): string[] {
  const og = (m.openGraph ?? {}) as Record<string, unknown>
  const tw = (m.twitter ?? {}) as Record<string, unknown>
  return [m.description, og.description, tw.description].map((s) => String(s ?? ""))
}

beforeEach(() => {
  cohortState.count = null
  cohortState.error = null
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) } as Response)),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ── 0. The fetcher itself, via injection rather than the module mock ───────

const { readCrossCollectionCohortSize } = await import("@/lib/insights/cross-collection-cohort")

/** Minimal supabase-js stand-in: `.from().select()` resolving a chosen shape. */
function dbReturning(shape: unknown) {
  return { from: () => ({ select: async () => shape }) }
}

describe("readCrossCollectionCohortSize", () => {
  it("returns the count when the read succeeds", async () => {
    expect(await readCrossCollectionCohortSize(dbReturning({ count: 220, error: null }))).toBe(220)
  })

  it("returns NULL — not 0 — when the query resolves an error", async () => {
    // supabase-js RESOLVES errors. This is the shape that `?? 0` turns into a
    // published measurement.
    expect(
      await readCrossCollectionCohortSize(dbReturning({ count: null, error: { message: "57014" } })),
    ).toBeNull()
  })

  it("returns NULL when the count is absent even with no error", async () => {
    expect(await readCrossCollectionCohortSize(dbReturning({ count: null, error: null }))).toBeNull()
  })

  it("returns NULL when the client THROWS (transport failure / abort)", async () => {
    const throwing = {
      from: () => ({
        select: async () => {
          throw new Error("fetch failed")
        },
      }),
    }
    expect(await readCrossCollectionCohortSize(throwing)).toBeNull()
  })

  it("NO-CHANGE CONTROL: a genuine zero-row cohort still reads 0, not null", async () => {
    // The opposite failure. If "never trust a falsy count" were the rule, an
    // empty cohort would be indistinguishable from an unreadable one — and the
    // honest answer for a real empty cohort is 0, not silence.
    expect(await readCrossCollectionCohortSize(dbReturning({ count: 0, error: null }))).toBe(0)
  })
})

// ── 1. SEO / OG / Twitter metadata ─────────────────────────────────────────

describe("cross-collection metadata reads the cohort size", () => {
  it("publishes the LIVE count in all three description fields", async () => {
    cohortState.count = 220
    const strings = metadataStrings((await generateMetadata()) as Record<string, unknown>)
    expect(strings).toHaveLength(3)
    for (const s of strings) expect(s).toContain("220 wallets hold")
    // The figure this replaced, pinned so a revert is loud.
    for (const s of strings) expect(s).not.toContain("143")
  })

  it("REGRESSION: a FAILED read publishes no count at all — never a zero", async () => {
    cohortState.count = null
    cohortState.error = { message: "canceling statement due to statement timeout" }
    const strings = metadataStrings((await generateMetadata()) as Record<string, unknown>)
    for (const s of strings) {
      expect(s).not.toMatch(POPULATION_CLAIM)
      expect(s).not.toMatch(/\b0\s+wallets/i)
      // Still a complete, useful sentence rather than a stub.
      expect(s.toLowerCase()).toContain("wallets that hold")
    }
  })

  it("REGRESSION: a non-numeric count is treated as unreadable, not as data", async () => {
    // supabase-js can resolve `{ count: null, error: null }`. `?? 0` on that is
    // the documented fabricated-number shape.
    cohortState.count = null
    cohortState.error = null
    const strings = metadataStrings((await generateMetadata()) as Record<string, unknown>)
    for (const s of strings) expect(s).not.toMatch(POPULATION_CLAIM)
  })

  it("keeps the shallow-merged openGraph/twitter objects complete", async () => {
    // openGraph and twitter REPLACE the root objects rather than merging into
    // them, so a route that drops siteName/locale/type loses them silently.
    cohortState.count = 220
    const m = (await generateMetadata()) as Record<string, unknown>
    const og = m.openGraph as Record<string, unknown>
    const tw = m.twitter as Record<string, unknown>
    expect(og.siteName).toBe("Rip Packs City")
    expect(og.locale).toBe("en_US")
    expect(og.type).toBe("website")
    expect(tw.creator).toBe("@RipPacksCity")
    expect(tw.card).toBe("summary_large_image")
  })
})

// ── 2. The share string the collector publishes under their own name ───────

function ccPayload(cohortSize: number | null) {
  return {
    meta: { fetched_at: "2026-08-26T00:00:00Z" },
    stats: {
      cohort_size: cohortSize,
      three_coll_wallets: 1, four_coll_wallets: 1, five_plus_coll_wallets: 1,
      cohort_total_moments: 10, avg_moments_per_wallet: 2, median_moments_per_wallet: 2,
      cohort_total_fmv_usd: 100, computed_at: "2026-08-26T00:00:00Z",
    },
    wallets: [],
    ts_set_overlap: [],
  }
}

function shareHref(): string {
  const a = Array.from(document.querySelectorAll("a")).find((el) =>
    (el.getAttribute("href") ?? "").includes("twitter.com/intent"),
  )
  return decodeURIComponent(a?.getAttribute("href") ?? "")
}

describe("cross-collection share text reads the cohort size", () => {
  it("broadcasts the LIVE count", () => {
    render(<CrossCollectionBoardClient initial={ccPayload(220) as never} />)
    const href = shareHref()
    expect(href).toContain("220 wallets hold")
    expect(href).not.toContain("143")
  })

  it("REGRESSION: an unreadable cohort drops the number rather than tweeting a zero", () => {
    render(<CrossCollectionBoardClient initial={ccPayload(null) as never} />)
    const href = shareHref()
    expect(href).not.toMatch(POPULATION_CLAIM)
    expect(href).not.toMatch(/\b0\s+wallets/i)
    expect(href).toContain("Wallets that hold")
  })
})

// ── 3. The squeeze board's ask-disconnect caveat ───────────────────────────

function sqRow(over: Record<string, unknown>) {
  return {
    edition_id: "e", external_id: "141:1", player_name: "P", set_name: "Base Set",
    tier: "COMMON", circulation: 1000, locked: 100, burned: 10, lock_pct: 10, burn_pct: 1,
    squeeze_pct: 60, effectively_buyable: 500, low_ask: 20, low_ask_disconnected: false,
    fmv_usd: 30, confidence: "HIGH", game_date: "2026-01-01",
    thumbnail_url: "https://example.com/a.png", ...over,
  }
}

describe("squeeze ask-disconnect caveat counts the rows in hand", () => {
  it("states the counts it can actually see, and not the retired literals", () => {
    render(
      <SqueezeBoardClient
        initialRows={[
          sqRow({ edition_id: "a", external_id: "141:2", low_ask_disconnected: true }),
          sqRow({ edition_id: "b", external_id: "141:3" }),
          sqRow({ edition_id: "c", external_id: "141:4", low_ask: null }),
        ] as never}
        initialFetchedAt="2026-08-26T00:00:00Z"
      />,
    )
    const body = document.body.textContent ?? ""
    // 2 rows carry an ask; 1 of them is disconnected. The third has no ask.
    expect(body).toContain("1 of 2 editions carrying")
    // The retired figures must not reappear.
    expect(body).not.toContain("8,859")
    expect(body).not.toContain("10 of the")
  })

  it("REGRESSION: renders no caveat sentence at all when no row carries an ask", () => {
    // "0 of 0 editions" is noise dressed as a measurement.
    render(
      <SqueezeBoardClient
        initialRows={[sqRow({ low_ask: null })] as never}
        initialFetchedAt="2026-08-26T00:00:00Z"
      />,
    )
    const body = document.body.textContent ?? ""
    expect(body).not.toContain("editions carrying")
    expect(body).not.toMatch(/\b0 of 0\b/)
    // Control: the surrounding methodology copy still renders, so this is a
    // suppressed SENTENCE and not a suppressed section.
    expect(body).toContain("hover the flag to see the listed number")
  })
})
