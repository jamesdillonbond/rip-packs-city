// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { mergeFmvAndAsk, asksAscending } from "@/lib/pinnacle/ask-history"
import { load } from "@/lib/pinnacle/moment-detail"
import PinnacleFmvChart, { AskCaption } from "@/components/pinnacle/PinnacleFmvChart"

// 2026-11-23: the Pinnacle pin page charts the lowest ask beside FMV, from the change-only
// pinnacle_floor_ask_history (since 2026-10-19). Three states, never two: a number, a recorded
// "no live ask" (null), and "not tracked yet" (undefined) — and a FAILED read is not an empty one.

afterEach(cleanup)

const fmv = (iso: string, v: number | null) => ({ computed_at: iso, fmv_usd: v, fmv_confidence: "MEDIUM", fmv_sales_count_30d: 2 })

describe("mergeFmvAndAsk", () => {
  it("carries both change-only series forward onto one ascending timeline", () => {
    const m = mergeFmvAndAsk(
      [fmv("2026-10-18T00:00:00Z", 10), fmv("2026-10-21T00:00:00Z", 12)],
      [
        { observed_at: "2026-10-19T13:45:00Z", floor_ask: 15 },
        { observed_at: "2026-10-22T00:00:00Z", floor_ask: null },
      ],
    )
    expect(m.map((p) => [p.fmv_usd, p.ask_usd])).toEqual([
      [10, undefined], // before ask tracking began: undefined, not null
      [10, 15],
      [12, 15],
      [12, null], // a recorded "no live ask" breaks the line
    ])
  })

  it("puts an FMV change and an ask change at the same instant on ONE point", () => {
    const m = mergeFmvAndAsk([fmv("2026-10-20T00:00:00Z", 9)], [{ observed_at: "2026-10-20T00:00:00Z", floor_ask: 11 }])
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ fmv_usd: 9, ask_usd: 11 })
  })

  it("never invents a 'now' point past the newest row (render-time clock = #418)", () => {
    const m = mergeFmvAndAsk([fmv("2026-10-20T00:00:00Z", 9)], [{ observed_at: "2026-10-21T00:00:00Z", floor_ask: 11 }])
    expect(m[m.length - 1].t).toBe("2026-10-21T00:00:00Z")
  })

  it("a failed ask read (null) leaves the ask undefined everywhere", () => {
    const m = mergeFmvAndAsk([fmv("2026-10-20T00:00:00Z", 9)], null)
    expect(m.every((p) => p.ask_usd === undefined)).toBe(true)
  })

  it("asksAscending keeps a failed read null, not []", () => {
    expect(asksAscending(null)).toBeNull()
    expect(asksAscending([{ observed_at: "2026-10-22T00:00:00Z", floor_ask: 1 }, { observed_at: "2026-10-20T00:00:00Z", floor_ask: 2 }])!.map((a) => a.floor_ask)).toEqual([2, 1])
  })
})

describe("AskCaption", () => {
  it("says the history is unavailable when the read failed — never 'no live ask'", () => {
    const { container } = render(<AskCaption asks={null} askKnown={false} />)
    expect(container.textContent).toContain("unavailable")
    expect(container.textContent).not.toContain("No live ask")
  })
  it("states 'no live ask recorded' only for a successful read with no ask", () => {
    const { container } = render(<AskCaption asks={[{ observed_at: "2026-10-20T00:00:00Z", floor_ask: null }]} askKnown={false} />)
    expect(container.textContent).toContain("No live ask recorded")
  })
  it("renders nothing when the caller passed no asks (FMV-only chart keeps its old shape)", () => {
    const { container } = render(<AskCaption asks={undefined} askKnown={false} />)
    expect(container.textContent).toBe("")
  })
})

describe("PinnacleFmvChart with asks", () => {
  const pts = [fmv("2026-10-18T00:00:00Z", 10), fmv("2026-10-21T00:00:00Z", 12), fmv("2026-10-24T00:00:00Z", 13)]
  it("keeps the 'too few FMV points' gate on FMV points alone (asks do not satisfy it)", () => {
    const { container } = render(
      <PinnacleFmvChart points={pts.slice(0, 2)} asks={[{ observed_at: "2026-10-19T00:00:00Z", floor_ask: 5 }, { observed_at: "2026-10-20T00:00:00Z", floor_ask: 6 }, { observed_at: "2026-10-22T00:00:00Z", floor_ask: 7 }]} />,
    )
    expect(container.textContent).toContain("too few FMV points")
  })
  it("shows the legend when an ask is known", () => {
    const { getByTestId } = render(<PinnacleFmvChart points={pts} asks={[{ observed_at: "2026-10-19T13:45:00Z", floor_ask: 15 }]} />)
    expect(getByTestId("pinnacle-ask-caption").textContent).toContain("Lowest ask on Disney Pinnacle")
  })
})

describe("load() reads the ask history and branches on the error", () => {
  const RENDER = "OEV1-SWHM-KYLO-S5"
  function makeDb(askResult: { data: unknown; error: unknown }) {
    const tablesSeen: string[] = []
    const build = (table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ["select", "eq", "in", "not", "order", "limit"]) b[m] = () => b
      const settle = () => {
        if (table === "pinnacle_catalog") return { data: { render_id: RENDER, edition_id: "2156", character_name: "Kylo Ren", total_minted: 500, fmv_usd: 42, floor_ask: 50 }, error: null, count: null }
        if (table === "pinnacle_floor_ask_history") return { ...askResult, count: null }
        if (table === "wallet_moments_cache") return { data: [], error: null, count: 0 }
        return { data: [], error: null, count: null }
      }
      b.maybeSingle = async () => settle()
      b.single = async () => settle()
      b.then = (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(settle()).then(f, r)
      return b
    }
    return { db: { from: (t: string) => { tablesSeen.push(t); return build(t) }, rpc: async () => ({ data: null, error: null }) }, tablesSeen }
  }

  it("returns the asks ascending on success", async () => {
    const { db, tablesSeen } = makeDb({ data: [{ observed_at: "2026-11-01T00:00:00Z", floor_ask: 9 }, { observed_at: "2026-10-20T00:00:00Z", floor_ask: 8 }], error: null })
    const r = await load(RENDER, db)
    expect(tablesSeen).toContain("pinnacle_floor_ask_history")
    const a = (r.data as { askHistory: { floor_ask: number }[] | null }).askHistory
    expect(a?.map((x) => x.floor_ask)).toEqual([8, 9])
  })

  it("returns null (unavailable), not [], when the ask read errors", async () => {
    const { db } = makeDb({ data: null, error: { message: "timeout" } })
    const r = await load(RENDER, db)
    expect(r.ok).toBe(true) // the pin page still renders
    expect((r.data as { askHistory: unknown }).askHistory).toBeNull()
  })
})
