// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 2026-11-23: Panini player checklist (Panini parity pass). Pins the honesty rules: a cost is labelled by its
// SOURCE, an ask on an unpriced card and an unpriced card are never folded into the headline, a username RPC has
// never seen is "not seen" (never "owns none"), a "seen" read is called a lower bound, a failed read is not empty,
// and the Panini owner is a USERNAME (never a wallet).

vi.mock("@/components/MomentMedia", () => ({ default: () => null }))

import PaniniPlayerChecklist from "@/components/panini/PaniniPlayerChecklist"
import { paniniCardPriceLabel, paniniCostSummary, paniniOwnershipNote, paniniChecklistUrl, type PaniniChecklistData } from "@/lib/panini/player-checklist"
import { PANINI_USERNAME_STORAGE_KEY } from "@/lib/panini/username-storage"

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => { try { window.localStorage.clear() } catch { /* ignore */ } })

const base: PaniniChecklistData = {
  player: "Damian Lillard", username: null, source: null, username_seen: null, profile_read_at: null,
  total: 3, owned: null, missing: null,
  cost_at_ask_usd: 10, priced_at_ask: 1, cost_at_fmv_usd: 5, priced_at_fmv: 1,
  cost_ask_no_fmv_usd: 900, priced_ask_no_fmv: 1, unpriced: 0,
  cards: [
    { external_id: "packcard-1587_290607_7860573_116", name: "Damian Lillard - Gold", set_name: "BC 2021-22 Prizm Base Prizms Gold", parallel: "x", product_name: "NBA 2021-22", tier: "LEGENDARY", mint_cap: 10, thumbnail_url: null, fmv_usd: 9, low_ask_usd: 10, cost_usd: 10, cost_source: "ask", owned_count: null },
  ],
}

describe("paniniCardPriceLabel", () => {
  it("names the source of every figure", () => {
    expect(paniniCardPriceLabel({ cost_usd: 10, cost_source: "ask" })).toBe("Ask $10.00")
    expect(paniniCardPriceLabel({ cost_usd: 5, cost_source: "fmv" })).toBe("FMV $5.00")
    expect(paniniCardPriceLabel({ cost_usd: 900, cost_source: "ask_no_fmv" })).toContain("no FMV")
    expect(paniniCardPriceLabel({ cost_usd: null, cost_source: null })).toBe("Unpriced")
  })
})

describe("paniniCostSummary", () => {
  it("keeps an ask on an unpriced card OUT of the headline", () => {
    const s = paniniCostSummary(base)
    expect(s.headline).toBe(15)
    expect(s.parts.join(" ")).toContain("not included")
  })
  it("never reports $0 for a player whose cards are only unpriced", () => {
    const s = paniniCostSummary({ ...base, cost_at_ask_usd: 0, priced_at_ask: 0, cost_at_fmv_usd: 0, priced_at_fmv: 0, priced_ask_no_fmv: 0, cost_ask_no_fmv_usd: 0, unpriced: 2 })
    expect(s.headline).toBeNull()
    expect(s.parts).toEqual(["2 unpriced, not included"])
  })
})

describe("paniniOwnershipNote", () => {
  const pt = () => "Nov 23, 2026, 5:49 AM PT"
  it("names the profile read and its time", () => {
    expect(paniniOwnershipNote({ username: "ywrr", source: "profile", username_seen: true, profile_read_at: "x" }, pt)).toContain("public Panini profile, read Nov 23")
  })
  it("calls a marketplace-seen read a lower bound, never the collection", () => {
    const n = paniniOwnershipNote({ username: "ywrr", source: "seen", username_seen: true, profile_read_at: null }, pt) ?? ""
    expect(n).toContain("lower bound")
    expect(n).not.toMatch(/your collection/i)
  })
})

function stubFetch(status: number, body: unknown) {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
  vi.stubGlobal("fetch", f)
  return f
}

describe("PaniniPlayerChecklist", () => {
  it("renders the cards and the cost line on success", async () => {
    stubFetch(200, base)
    const { container } = render(<PaniniPlayerChecklist slug="damian-lillard" player="Damian Lillard" />)
    await waitFor(() => expect(container.textContent).toContain("3 cards"))
    expect(container.textContent).toContain("Cost of every card")
    expect(container.textContent).toContain("Ask $10.00")
    expect(container.querySelector('a[href="/panini-blockchain/edition/packcard-1587_290607_7860573_116"]')).not.toBeNull()
  })

  it("says the read failed — never an empty or zero-owned checklist", async () => {
    stubFetch(500, { error: "x" })
    const { container } = render(<PaniniPlayerChecklist slug="damian-lillard" player="Damian Lillard" />)
    await waitFor(() => expect(container.textContent).toContain("couldn't load"))
    expect(container.textContent).not.toContain("0 of")
  })

  it("hides itself on a 404 (the player has no Panini cards)", async () => {
    stubFetch(404, { error: "none" })
    const { container } = render(<PaniniPlayerChecklist slug="nobody" player="Nobody" />)
    await waitFor(() => expect(container.textContent).toBe(""))
  })

  it("a username RPC has never seen reads 'hasn't seen', never 'owns none' or '0 of'", async () => {
    window.localStorage.setItem(PANINI_USERNAME_STORAGE_KEY, "nobody_zz")
    stubFetch(200, { ...base, username: "nobody_zz", source: "seen", username_seen: false, owned: 0, missing: 3 })
    const { container } = render(<PaniniPlayerChecklist slug="damian-lillard" player="Damian Lillard" />)
    await waitFor(() => expect(container.textContent).toContain("hasn't seen a Panini card under"))
    expect(container.textContent).not.toContain("0 of 3")
    expect(container.textContent).not.toMatch(/Missing/)
  })

  it("reads the username the Collection tab saved and sends it as ?username=", async () => {
    window.localStorage.setItem(PANINI_USERNAME_STORAGE_KEY, "YWRR")
    const f = stubFetch(200, { ...base, username: "ywrr", source: "profile", username_seen: true, profile_read_at: "2026-11-23T13:49:36Z", owned: 1, missing: 2 })
    const { container } = render(<PaniniPlayerChecklist slug="damian-lillard" player="Damian Lillard" />)
    await waitFor(() => expect(container.textContent).toContain("1 of 3 cards owned"))
    expect(String((f.mock.calls.at(-1) as unknown[] | undefined)?.[0])).toContain("username=ywrr")
    expect(container.textContent).toContain("Cost to complete")
  })

  it("refuses a malformed username instead of tracking it", async () => {
    stubFetch(200, base)
    const { container, getByPlaceholderText, getByText } = render(<PaniniPlayerChecklist slug="damian-lillard" player="Damian Lillard" />)
    await waitFor(() => expect(container.textContent).toContain("3 cards"))
    fireEvent.change(getByPlaceholderText("Panini username"), { target: { value: "0x94860edbafac862e!!" } })
    fireEvent.click(getByText("Track"))
    expect(container.textContent).toContain("doesn't look like a Panini username")
    expect(window.localStorage.getItem(PANINI_USERNAME_STORAGE_KEY)).toBeNull()
  })
})

describe("franchise checklist (hub Panini panel, pass 2)", () => {
  it("reads the franchise route — never the player route under a team's name", () => {
    expect(paniniChecklistUrl({ kind: "franchise", league: "NBA", team: "blazers" }, "ywrr")).toBe("/api/entity/panini-franchise-checklist?league=NBA&team=blazers&username=ywrr")
    expect(paniniChecklistUrl({ kind: "player", slug: "damian-lillard" }, null)).toBe("/api/entity/panini-player-checklist?slug=damian-lillard")
  })
  it("names each tile's player and the franchise in the complete line", async () => {
    window.localStorage.setItem(PANINI_USERNAME_STORAGE_KEY, "ywrr")
    const card = { ...base.cards[0], player_name: "Damian Lillard", owned_count: 1 }
    const f = stubFetch(200, { ...base, player: undefined, franchise_key: "NBA:blazers", username: "ywrr", source: "profile", username_seen: true, profile_read_at: "2026-11-23T13:49:36Z", total: 1, owned: 1, missing: 0, cards: [card] })
    const { container } = render(<PaniniPlayerChecklist player="Portland Trail Blazers" franchise={{ league: "NBA", team: "blazers" }} />)
    await waitFor(() => expect(container.textContent).toContain("1 of 1 cards owned"))
    expect(String((f.mock.calls.at(-1) as unknown[] | undefined)?.[0])).toContain("/api/entity/panini-franchise-checklist?league=NBA&team=blazers")
    expect(container.textContent).toContain("Damian Lillard")
    expect(container.textContent).toContain("holds every Portland Trail Blazers card")
  })
})

describe("wiring", () => {
  it("the franchise hub's Panini panel renders the franchise checklist", () => {
    const page = readFileSync(join(process.cwd(), "app/teams/[league]/[slug]/page.tsx"), "utf8")
    expect(page).toMatch(/<PaniniPlayerChecklist player=\{hub\.team_name\} franchise=\{\{ league: hub\.league, team: hub\.team_slug \}\} \/>/)
    const route = readFileSync(join(process.cwd(), "app/api/entity/panini-franchise-checklist/route.ts"), "utf8")
    expect(route).toContain('"get_panini_franchise_checklist"')
    expect(route).toContain("normalizePaniniUsername")
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261124025412_audit_20261123_panini_franchise_checklist.sql"), "utf8")
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_panini_franchise_checklist\(text, text, text\) FROM PUBLIC, anon, authenticated/)
  })

  const root = process.cwd()
  it("the Panini player page renders the checklist", () => {
    const page = readFileSync(join(root, "app/(collections)/[collection]/player/[slug]/page.tsx"), "utf8")
    expect(page).toMatch(/isPanini \? \(\s*<Section title=\{`\$\{detail\.name\} Checklist`\}>\s*<PaniniPlayerChecklist slug=\{slug\}/)
  })
  it("the route validates the username as a Panini username and reads the service-role RPC", () => {
    const route = readFileSync(join(root, "app/api/entity/panini-player-checklist/route.ts"), "utf8")
    expect(route).toContain("normalizePaniniUsername")
    expect(route).toContain('"get_panini_player_checklist"')
    expect(route).toContain("apiErrorResponse")
  })
  it("the migration revokes the function from anon/authenticated", () => {
    const sql = readFileSync(join(root, "supabase/migrations/20261124013251_audit_20261123_panini_player_checklist.sql"), "utf8")
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_panini_player_checklist\(text, text\) FROM PUBLIC, anon, authenticated/)
  })
})
