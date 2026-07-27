// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import type React from "react"
import { render, cleanup, fireEvent } from "@testing-library/react"

// CandyBoardClient is the whole /insights/candy-mlb surface — nine tabs, ~600
// lines — and it had ZERO render coverage while four of its tabs changed on
// 2026-07-27 (Market gained a serial-annotated last sale + a Median sale column,
// Deals gained a "vs median sale" column, the pack panel gained a realised-price
// tile, the Serials footnote lost a false claim). This sandbox cannot render the
// real page, so these tests pin the DOM STRUCTURE the type-checker cannot:
// header/cell counts matching per tab, the empty-state colSpan, and the
// conditional blocks appearing only when their data exists.
//
// This is not a substitute for a visual/390px pass — it catches a broken table,
// not a broken layout.

import CandyBoardClient from "@/app/insights/candy-mlb/CandyBoardClient"

const marketRow = {
  external_id: "bobby-witt-jr",
  player_name: "Bobby Witt Jr.",
  edition_name: "Bobby Witt Jr.",
  tier: "COMMON",
  is_rainbow: false,
  circulation_count: 250,
  fmv_usd: 8.31,
  fmv_computed_at: "2026-07-27T10:00:00Z",
  sales_24h: 1,
  sales_7d: 4,
  sales_all: 4,
  last_sale_at: "2026-07-27T09:00:00Z",
  last_sale_usd: 20.04,
  last_sale_serial: 118,
  median_sale_usd: 4.44,
  best_offer_usd: 1.5,
  offer_bidders: 2,
  floor_ask_usd: 4.58,
  listing_count: 3,
  excluded_troll_count: 0,
}

const packEv = {
  icon_slots: 10,
  rainbow_chance: 0.15,
  pack_cost_usd: 10,
  common_total: 100,
  common_priced: 98,
  rainbow_total: 25,
  rainbow_priced: 11,
  actual_ev_usd: 63.81,
  typical_pull_ev_usd: 34.2,
}

const packMarket = {
  pack_assets_indexed: 2501,
  collector_held: 271,
  collector_wallets: 108,
  active_asks: 1,
  floor_ask_usd: 64.87,
  sales_all: 4,
  sales_7d: 4,
  median_7d_usd: 33.78,
  last_sale_usd: 33.18,
  last_sale_at: "2026-07-27T04:06:51Z",
  retail_usd: 10,
  median_vs_retail_x: 3.38,
  median_vs_typical_pull_x: 0.99,
  median_vs_actual_ev_x: 0.53,
}

const dealRow = {
  pda_address: "pda1",
  external_id: "jordan-walker",
  player_name: "Jordan Walker",
  edition_name: "Jordan Walker",
  tier: "COMMON",
  is_rainbow: false,
  circulation_count: 250,
  serial_number: 243,
  ask_usd: 5,
  fmv_usd: 10.49,
  discount_pct: 52.3,
  median_sale_usd: 7.01,
  sales_count: 3,
  discount_vs_median_pct: 28.7,
  seller: "5D6FtKAWRszBXPheGHEvA9iAMz9JPo4ocKEHLHZ2auMJ",
}

const serialRow = {
  external_id: "mike-trout",
  player_name: "Mike Trout",
  edition_name: "Mike Trout",
  tier: "COMMON",
  is_rainbow: false,
  circulation_count: 250,
  serial_number: 1,
  kind: "first_mint",
  owner: "BhA2Bfd8t2F2jDiUNdioGRJQt7MiaWo3Ro5H2Yt7APe2",
  is_treasury: true,
  fmv_usd: 5.5,
  last_sale_usd: null,
  last_sale_at: null,
}

type BoardProps = React.ComponentProps<typeof CandyBoardClient>

function mount(overrides: Record<string, unknown> = {}) {
  const props = {
    initialRows: [marketRow],
    packEv,
    packMarket,
    deals: [dealRow],
    serials: [serialRow],
    fetchedAt: "2026-07-27T10:30:00Z",
    ...overrides,
  } as unknown as BoardProps
  return render(<CandyBoardClient {...props} />)
}

// Tab buttons carry a count badge for some tabs ("Deals3"), so match on the
// label PREFIX rather than exact text.
function tabButton(container: HTMLElement, label: string): HTMLElement {
  const el = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith(label),
  )
  if (!el) throw new Error(`tab "${label}" not found`)
  return el as HTMLElement
}

afterEach(cleanup)

describe("CandyBoardClient — Market tab", () => {
  it("renders one cell per header, so the added Median sale column cannot desync the table", () => {
    const { container } = mount()
    const headers = container.querySelectorAll("thead th")
    const cells = container.querySelectorAll("tbody tr td")
    expect(headers.length).toBeGreaterThan(0)
    expect(cells).toHaveLength(headers.length)
  })

  it("annotates the last sale with its serial and shows the median beside it", () => {
    const { container } = mount()
    const text = container.textContent ?? ""
    // The print, its serial, and what the edition actually trades at. Without
    // the median, a $20.04 print on a $4.44 market reads as the price.
    expect(text).toContain("#118")
    expect(text).toMatch(/\$20\.04/)
    expect(text).toMatch(/\$4\.44/)
    expect([...container.querySelectorAll("thead th")].map((h) => h.textContent)).toContain("Median sale")
  })

  it("spans the empty state across every column (colSpan tracks the header count)", () => {
    const { container } = mount({ initialRows: [] })
    const empty = container.querySelector("tbody td[colspan]")
    const headers = container.querySelectorAll("thead th")
    expect(empty).not.toBeNull()
    expect(Number(empty?.getAttribute("colspan"))).toBe(headers.length)
  })

  it("never renders an FMV confidence tier (site-wide policy)", () => {
    const { container } = mount({
      initialRows: [{ ...marketRow, confidence: "MEDIUM" }],
    })
    expect(container.textContent ?? "").not.toMatch(/\b(LOW|MEDIUM|HIGH)\b/)
  })
})

describe("CandyBoardClient — pack panel", () => {
  it("shows the realised pack price beside the model when a median exists", () => {
    const { container } = mount()
    const text = container.textContent ?? ""
    expect(text).toContain("Packs actually sell for")
    expect(text).toMatch(/\$33\.78/)
    // and states the comparison rather than leaving the model to stand alone
    expect(text).toMatch(/3\.38/)
    expect(text).toMatch(/0\.99/)
  })

  it("omits the realised-price tile entirely when no pack has sold", () => {
    const { container } = mount({ packMarket: { ...packMarket, median_7d_usd: null } })
    const text = container.textContent ?? ""
    expect(text).not.toContain("Packs actually sell for")
    // the model itself still renders
    expect(text).toContain("Typical pull value")
  })

  it("survives a missing pack-market payload without dropping the EV panel", () => {
    const { container } = mount({ packMarket: null })
    expect(container.textContent ?? "").toContain("Typical pull value")
    expect(container.textContent ?? "").not.toContain("Packs actually sell for")
  })

  it("no longer claims every FMV comes off 1-2 sales", () => {
    const { container } = mount()
    expect(container.textContent ?? "").not.toMatch(/1–2 sales|1-2 sales/)
  })
})

describe("CandyBoardClient — Deals tab", () => {
  it("shows the FMV discount and the median-sale discount side by side", () => {
    const { container } = mount()
    fireEvent.click(tabButton(container, "Deals"))
    // The sorted column carries a " ▲"/" ▼" indicator in its header text, and
    // Deals now defaults to sorting by the median-based figure — so match on the
    // label prefix rather than exact equality.
    const headers = [...container.querySelectorAll("thead th")].map((h) => (h.textContent ?? "").trim())
    expect(headers.some((h) => h.startsWith("vs FMV"))).toBe(true)
    expect(headers.some((h) => h.startsWith("vs median sale"))).toBe(true)
    const cells = container.querySelectorAll("tbody tr td")
    expect(cells).toHaveLength(headers.length)
  })

  it("renders an em-dash for the median discount when the edition has never sold", () => {
    const { container } = mount({
      deals: [{ ...dealRow, median_sale_usd: null, sales_count: null, discount_vs_median_pct: null }],
    })
    fireEvent.click(tabButton(container, "Deals"))
    expect(container.textContent ?? "").toContain("—")
  })

  it("explains the median guard rather than promising arbitrage", () => {
    const { container } = mount()
    fireEvent.click(tabButton(container, "Deals"))
    const text = container.textContent ?? ""
    expect(text).toMatch(/median sale/i)
    expect(text).toMatch(/indicative, not arbitrage/i)
  })
})

describe("CandyBoardClient — Serials tab", () => {
  it("flags treasury-held specials as SEALED", () => {
    const { container } = mount()
    fireEvent.click(tabButton(container, "Serials"))
    expect(container.textContent ?? "").toContain("SEALED")
  })

  it("no longer claims Candy players carry no jersey number", () => {
    const { container } = mount()
    fireEvent.click(tabButton(container, "Serials"))
    const text = container.textContent ?? ""
    // The claim was false — every ICON carries a Player Number trait (Judge #99,
    // Machado #13, Trout #27). The copy may say we do not SURFACE the match yet.
    expect(text).not.toMatch(/carry no jersey number/i)
  })
})

// ── A production-only copy defect these render tests could not catch ───────
//
// Found 2026-07-27 by reading the DEPLOYED DOM, not by any test. The live board
// renders two phrases with the space missing:
//     "only 110 of 125editions have traded"
//     "42 outlier listingspriced >10x ..."
// Both are in the served HTML (`<b>125</b>editions`), so it is not a client-side
// artifact, and the same response carried "Median sale" — a string that only
// entered this file today — so the markup and the new column came from the same
// build.
//
// ROOT CAUSE IS NOT ESTABLISHED. The obvious hypothesis — that the production
// (Next/SWC) and test (vitest/esbuild) JSX transforms disagree about a text run
// that follows an expression and wraps to the next line — is DISPROVEN:
// PaniniSqueezeClient.tsx:155 has the byte-identical shape
//     <b>{num(coverage.total_editions)}</b> editions of this set. Panini
//     publishes no full checklist...
// and renders WITH the space in production. No commit in this file's history has
// the unspaced source, either. The page was also served `x-vercel-cache: STALE`,
// which has not been ruled out. Left open deliberately rather than written up as
// a mechanism I cannot demonstrate.
//
// What IS true regardless of cause: an explicit {" "} renders correctly under
// every transform and every cache state, and is the idiomatic React way to say
// "a space belongs here". The three sites in this file now use it.
//
// The check below is therefore a STYLE rule, not a proof of the defect — it
// keeps this file's expression-adjacent line wraps explicit so the question
// cannot recur here while the root cause is still open. It is intentionally
// scoped to this one file.
// ── Jersey-match serials (the 4th kind, shipped 2026-07-27) ────────────────
//
// The Serials tab had three kinds (first_mint / last_mint / low_serial) and its
// formatter mapped EVERYTHING that was not first/last to the "Low" label. So the
// moment editions.jersey_number filled on the daily walk, every jersey row would
// have rendered as a low serial — a wrong label on a live board, produced by a
// view change alone with no code change to notice.
describe("CandyBoardClient — Serials, jersey_match kind", () => {
  const jerseyRow = { ...serialRow, external_id: "aaron-judge", player_name: "Aaron Judge",
    edition_name: "Aaron Judge", serial_number: 99, kind: "jersey_match", is_treasury: false }

  it("labels a jersey_match row Jersey, not Low", () => {
    const { container } = mount({ serials: [jerseyRow] })
    fireEvent.click(tabButton(container, "Serials"))
    const text = container.textContent ?? ""
    expect(text).toContain("Jersey")
    // the specific regression: it must NOT fall through to the low-serial label
    expect(container.querySelector(".cdy-kind.jersey")).not.toBeNull()
    expect(container.querySelector(".cdy-kind.low")).toBeNull()
  })

  it("still labels the other three kinds correctly alongside it", () => {
    const rows = [
      { ...serialRow, kind: "first_mint", serial_number: 1 },
      { ...serialRow, kind: "last_mint", serial_number: 250 },
      { ...serialRow, kind: "low_serial", serial_number: 3 },
      jerseyRow,
    ]
    const { container } = mount({ serials: rows })
    fireEvent.click(tabButton(container, "Serials"))
    const kinds = [...container.querySelectorAll(".cdy-kind")].map((e) => e.textContent)
    expect(kinds).toEqual(["#1 First", "Last", "Low", "Jersey"])
  })

  it("gives every row a unique React key — four rows of one edition must not collide", () => {
    // Regression: the row key was `external_id` (first truthy of a list), but the
    // Serials tab renders up to four rows PER edition. All 500 rows shipped with
    // duplicate keys, and this table re-sorts on every header click, which is
    // exactly when React's duplicate-key behaviour (omit/duplicate children)
    // bites. Assert via the console warning React emits.
    const errs: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(" "))
    })
    try {
      const rows = ["first_mint", "last_mint", "low_serial", "jersey_match"].map((kind, n) => ({
        ...serialRow, kind, serial_number: n + 1,
      })) // all four share external_id "mike-trout"
      const { container } = mount({ serials: rows })
      fireEvent.click(tabButton(container, "Serials"))
      expect(container.querySelectorAll("tbody tr")).toHaveLength(4)
      expect(errs.filter((e) => /same key/i.test(e))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it("does not truncate a full four-kind board (the cap must clear 625)", () => {
    // 125 editions x 4 kinds = 625 theoretical max. The cap was 550 and the fetch
    // limit 600 — both below that, and both silent (DataTable does r.slice(0, cap)
    // with no "showing N of M"). This pins that a 625-row board renders whole.
    const rows = Array.from({ length: 625 }, (_, i) => ({
      ...serialRow, external_id: `ed-${i}`, serial_number: (i % 250) + 1,
      kind: ["first_mint", "last_mint", "low_serial", "jersey_match"][i % 4],
    }))
    const { container } = mount({ serials: rows })
    fireEvent.click(tabButton(container, "Serials"))
    expect(container.querySelectorAll("tbody tr")).toHaveLength(625)
  })
})

describe("CandyBoardClient — JSX whitespace is explicit (style rule, see note above)", () => {
  it("keeps an explicit {\" \"} between an expression and a line-wrapped text run", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("app/insights/candy-mlb/CandyBoardClient.tsx", "utf8")
    const lines = src.split("\n")
    const implicit: string[] = []

    // children position = not inside an unclosed `<tag ...`
    const inChildren = (line: string, idx: number) => {
      let depth = 0
      for (const ch of line.slice(0, idx)) {
        if (ch === "<") depth++
        else if (ch === ">") depth = Math.max(0, depth - 1)
      }
      return depth === 0
    }

    lines.forEach((raw, i) => {
      const line = raw.replace(/\s+$/, "")
      if (/^\s*(import|export|\/\/|\*|\/\*)/.test(line)) return
      if (line.includes("`") || line.endsWith(",") || line.endsWith("+")) return
      // a text run that starts after `}` (optionally through a closing tag)...
      const m = /\}(?:<\/[A-Za-z][\w.]*>)?( [A-Za-z&“"][^<{}]*)$/.exec(line)
      if (!m) return
      const run = m[1]
      if (run.includes("=") || run.trim().length < 4) return
      if (!inChildren(line, m.index)) return
      // ...and wraps onto more plain text
      const next = (lines[i + 1] ?? "").trim()
      if (!next || "<{}/)".includes(next[0]) || /^[\w-]+=/.test(next)) return
      implicit.push(`L${i + 1}: ...${line.trim().slice(-70)}`)
    })

    expect(implicit).toEqual([])
  })
})
