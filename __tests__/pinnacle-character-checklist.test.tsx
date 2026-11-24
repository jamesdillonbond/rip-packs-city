// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 2026-11-23: Disney Pinnacle character checklist (render grain). Pins the honesty rules:
// a cost is labelled by its SOURCE, a never-sold ask and an unpriced pin are never folded into the
// headline, an unindexed wallet is "not indexed" (never "owns none"), a failed read is not empty.

vi.mock("@/lib/hooks/useSessionOwner", () => ({
  useSessionOwner: () => ({ userId: null, walletAddr: null, username: null, email: null, displayName: null, loading: false, degraded: false }),
}))

import PinnacleCharacterChecklist, { costSummary, pinPriceLabel, type PinnacleChecklistData } from "@/components/pinnacle/PinnacleCharacterChecklist"

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => { try { window.localStorage.clear() } catch { /* ignore */ } })

const base: PinnacleChecklistData = {
  character: "Mickey Mouse", wallet: null, wallet_cached: null, total: 3, owned: null, missing: null,
  cost_at_ask_usd: 10, priced_at_ask: 1, cost_at_fmv_usd: 5, priced_at_fmv: 1,
  cost_ask_no_fmv_usd: 1_000_000, priced_ask_no_fmv: 1, unpriced: 0,
  pins: [
    { render_id: "A", name: "Mickey Mouse", set_name: "S", series_name: "2026", edition_type: "Open Edition", variant: "Golden", parallel_type: null, printing: 1, total_minted: 500, is_chaser: false, thumbnail_url: null, fmv_usd: 9, floor_ask_usd: 10, cost_usd: 10, cost_source: "ask", owned_count: null },
  ],
}

describe("pinPriceLabel", () => {
  it("names the source of every figure", () => {
    expect(pinPriceLabel({ cost_usd: 10, cost_source: "ask" })).toBe("Ask $10.00")
    expect(pinPriceLabel({ cost_usd: 5, cost_source: "fmv" })).toBe("FMV $5.00")
    expect(pinPriceLabel({ cost_usd: 1_000_000, cost_source: "ask_no_fmv" })).toContain("never sold")
    expect(pinPriceLabel({ cost_usd: null, cost_source: null })).toBe("Unpriced")
  })
})

describe("costSummary", () => {
  it("keeps a never-sold ask OUT of the headline (a $1M Apex ask was 99.7 % of Mickey's cost)", () => {
    const s = costSummary(base)
    expect(s.headline).toBe(15)
    expect(s.parts.join(" ")).toContain("not included")
  })
  it("never reports $0 for a set that is only unpriced", () => {
    const s = costSummary({ ...base, cost_at_ask_usd: 0, priced_at_ask: 0, cost_at_fmv_usd: 0, priced_at_fmv: 0, priced_ask_no_fmv: 0, cost_ask_no_fmv_usd: 0, unpriced: 2 })
    expect(s.headline).toBeNull()
    expect(s.parts).toEqual(["2 unpriced, not included"])
  })
})

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })))
}

describe("PinnacleCharacterChecklist", () => {
  it("renders the pins and the cost line on success", async () => {
    stubFetch(200, base)
    const { container } = render(<PinnacleCharacterChecklist character="Mickey Mouse" />)
    await waitFor(() => expect(container.textContent).toContain("3 pins"))
    expect(container.textContent).toContain("Cost of the full set")
    expect(container.textContent).toContain("Ask $10.00")
  })

  it("says the read failed — never an empty or zero-owned checklist", async () => {
    stubFetch(500, { error: "x" })
    const { container } = render(<PinnacleCharacterChecklist character="Mickey Mouse" />)
    await waitFor(() => expect(container.textContent).toContain("couldn't load"))
    expect(container.textContent).not.toContain("0 of")
  })

  it("hides itself on a 404 (the character has no pins)", async () => {
    stubFetch(404, { error: "no pins" })
    const { container } = render(<PinnacleCharacterChecklist character="Nobody" />)
    await waitFor(() => expect(container.textContent).toBe(""))
  })

  it("an unindexed wallet reads 'not indexed', never 'owns none'", async () => {
    window.localStorage.setItem("rpc_checklist_wallet", "0x94860edbafac862e")
    stubFetch(200, { ...base, wallet: "0x94860edbafac862e", wallet_cached: false, owned: 0, missing: 3 })
    const { container } = render(<PinnacleCharacterChecklist character="Mickey Mouse" />)
    await waitFor(() => expect(container.textContent).toContain("hasn't indexed"))
    expect(container.textContent).not.toContain("0 of 3")
  })
})

describe("PinnacleCharacterChecklist interactions", () => {
  const owned: PinnacleChecklistData = {
    ...base, wallet: "0x94860edbafac862e", wallet_cached: true, total: 2, owned: 1, missing: 1,
    pins: [
      { ...base.pins[0], render_id: "OWN", name: "Owned Mickey", owned_count: 2 },
      { ...base.pins[0], render_id: "MISS", name: "Missing Mickey", owned_count: 0 },
    ],
  }

  it("refuses a bad address, tracks a good one, filters to missing, and clears", async () => {
    const f = vi.fn(async (url: string) => {
      const body = String(url).includes("wallet=") ? owned : base
      return new Response(JSON.stringify(body), { status: 200 })
    })
    vi.stubGlobal("fetch", f)
    const { container, getByPlaceholderText, getByText, getByLabelText } = render(<PinnacleCharacterChecklist character="Mickey Mouse" />)
    await waitFor(() => expect(container.textContent).toContain("3 pins"))

    fireEvent.change(getByPlaceholderText("0x… Dapper wallet"), { target: { value: "not-a-wallet" } })
    fireEvent.click(getByText("Track"))
    expect(container.textContent).toContain("Enter a Dapper wallet address")

    fireEvent.change(getByPlaceholderText("0x… Dapper wallet"), { target: { value: "0x94860EDBAFAC862E" } })
    fireEvent.click(getByText("Track"))
    await waitFor(() => expect(container.textContent).toContain("1 of 2 pins owned"))
    expect(window.localStorage.getItem("rpc_checklist_wallet")).toBe("0x94860edbafac862e")
    expect(container.textContent).toContain("✓ ×2")
    expect(container.textContent).toContain("Cost to complete")

    fireEvent.click(getByLabelText("Missing only"))
    expect(container.textContent).not.toContain("Owned Mickey")
    expect(container.textContent).toContain("Missing Mickey")

    fireEvent.click(getByText("Clear"))
    await waitFor(() => expect(container.textContent).toContain("3 pins"))
    expect(window.localStorage.getItem("rpc_checklist_wallet")).toBeNull()
  })

  it("retries after a failure", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(base), { status: 200 }))))
    const { container, getByText } = render(<PinnacleCharacterChecklist character="Mickey Mouse" />)
    await waitFor(() => expect(container.textContent).toContain("couldn't load"))
    fireEvent.click(getByText("Retry"))
    await waitFor(() => expect(container.textContent).toContain("3 pins"))
  })

  it("a complete wallet says Complete, not a $0 cost", async () => {
    window.localStorage.setItem("rpc_checklist_wallet", "0x94860edbafac862e")
    stubFetch(200, { ...owned, owned: 2, missing: 0, priced_at_ask: 0, priced_at_fmv: 0, priced_ask_no_fmv: 0, cost_at_ask_usd: 0, cost_at_fmv_usd: 0, cost_ask_no_fmv_usd: 0 })
    const { container } = render(<PinnacleCharacterChecklist character="Mickey Mouse" />)
    await waitFor(() => expect(container.textContent).toContain("Complete"))
    expect(container.textContent).not.toContain("$0")
  })

  it("a malformed 200 body is a failure, not an empty checklist", async () => {
    stubFetch(200, { nope: true })
    const { container } = render(<PinnacleCharacterChecklist character="Mickey Mouse" />)
    await waitFor(() => expect(container.textContent).toContain("couldn't load"))
  })
})

describe("franchise kind (pass 2)", () => {
  it("asks the route for kind=franchise and caps the first render at CHECKLIST_PAGE tiles", async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ ...base.pins[0], render_id: `R${i}`, name: `Pin ${i}` }))
    const f = vi.fn(async () => new Response(JSON.stringify({ ...base, total: 130, pins: many }), { status: 200 }))
    vi.stubGlobal("fetch", f)
    const { container, getByText } = render(<PinnacleCharacterChecklist character="Star Wars" kind="franchise" />)
    await waitFor(() => expect(container.textContent).toContain("130 pins"))
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("kind=franchise")
    expect(container.querySelectorAll("a[href^='/pinnacle/moment/']").length).toBe(120)
    fireEvent.click(getByText("Show all 130 pins"))
    expect(container.querySelectorAll("a[href^='/pinnacle/moment/']").length).toBe(130)
  })
  it("the character kind sends no kind param", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(base), { status: 200 }))
    vi.stubGlobal("fetch", f)
    render(<PinnacleCharacterChecklist character="Grogu" />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(String((f.mock.calls[0] as unknown[])[0])).not.toContain("kind=")
  })
  it("the team page shows ONE franchise checklist (TeamChecklist), never a second one; the route refuses an unknown kind", () => {
    const page = readFileSync(join(process.cwd(), "app/(collections)/[collection]/team/[slug]/page.tsx"), "utf8")
    // 2026-11-23: two checklists with two costs on /disney-pinnacle/team/<slug> — the duplicate mount was removed.
    expect(page).not.toMatch(/<PinnacleCharacterChecklist/)
    expect(page).toMatch(/<TeamChecklist collectionUrlSlug=\{collection\} teamSlug=\{slug\} \/>/)
    const route = readFileSync(join(process.cwd(), "app/api/entity/pinnacle-character-checklist/route.ts"), "utf8")
    expect(route).toMatch(/kind !== "character" && kind !== "franchise"[\s\S]*status: 400/)
    expect(route).toContain('"get_pinnacle_checklist"')
  })
})

describe("wiring", () => {
  it("the character page mounts the checklist only on Disney Pinnacle characters", () => {
    const src = readFileSync(join(process.cwd(), "app/(collections)/[collection]/player/[slug]/page.tsx"), "utf8")
    expect(src).toMatch(/collection === "disney-pinnacle" && isCharacter \? \(\s*<Section[^>]*>\s*<PinnacleCharacterChecklist character=\{detail\.name\} \/>/)
  })
  it("the route reads the render-grain RPC and maps a null result to 404", () => {
    const src = readFileSync(join(process.cwd(), "app/api/entity/pinnacle-character-checklist/route.ts"), "utf8")
    expect(src).toContain('"get_pinnacle_checklist"')
    expect(src).toMatch(/if \(error\) return apiErrorResponse/)
    expect(src).toMatch(/data == null\) return NextResponse\.json\([^)]*\{ status: 404 \}/)
  })
})
