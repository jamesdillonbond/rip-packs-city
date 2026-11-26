// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import type React from "react"

/**
 * Candy Sets tab — every Candy collection a wallet holds (2026-11-26, migration 20261126231408).
 * - three states: a failed read says so (never "holds nothing"), an empty wallet says that, else rows;
 * - the brand chips narrow the list exactly (it is all on the client);
 * - the API refuses a non-Solana address and passes a Solana key through untouched.
 */

vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
const db = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown>]>, res: { data: null as unknown, error: null as unknown } }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async (fn: string, args: Record<string, unknown>) => { db.calls.push([fn, args]); return db.res } } }))
const fj = vi.hoisted(() => ({ ok: true, json: null as unknown }))
vi.mock("@/lib/analytics/fetch-json", () => ({ fetchJson: async () => ({ ok: fj.ok, json: fj.ok ? fj.json : null }) }))

import { toCandyCollectionsProgress, progressBrandOptions } from "@/lib/candy/collections-progress"
import CandyCollectionsProgress from "@/components/collection/CandyCollectionsProgress"
import { GET } from "@/app/api/candy-collections-progress/route"
import { isPublicPath } from "@/proxy"

afterEach(cleanup)
beforeEach(() => { db.calls.length = 0; db.res = { data: null, error: null }; fj.ok = true; fj.json = null })

const row = (name: string, brand: string | null, brand_name: string | null, owned: number, editions: number, cards = owned) => ({ name, set_slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), brand, brand_name, line: null, editions, owned_editions: owned, cards })
const raw = { collections_total: 398, collections: [row("Batman 1", "dc", "DC", 5, 5, 9), row("Superman 1", "dc", "DC", 1, 7), row("2026 MLB Base Series ICONs", "mlb", "MLB", 40, 125, 60), row("Bank of America", null, null, 1, 1), { name: "Broken", editions: 0, owned_editions: 0 }] }
const WALLET = "6uKecEEDfWyWY6HLkPJ2kpKUgq8HekLRjtuTatoPqCaW"

describe("Candy collections progress", () => {
  it("parses, drops a row with no catalogued cards, caps owned at catalogued, and lists the brands present", () => {
    const p = toCandyCollectionsProgress({ ...raw, collections: [...raw.collections, row("Over", "dc", "DC", 9, 4)] })!
    expect(p.collections.map((c) => c.name)).toEqual(["Batman 1", "Superman 1", "2026 MLB Base Series ICONs", "Bank of America", "Over"])
    expect(p.collections[4].owned_editions).toBe(4)
    expect(progressBrandOptions(p.collections)).toEqual([{ slug: "dc", name: "DC", collections: 3 }, { slug: "mlb", name: "MLB", collections: 1 }])
    expect(toCandyCollectionsProgress(null)).toBeNull()
    expect(toCandyCollectionsProgress({ collections: [] })).toBeNull()
  })
  it("renders the rows with brand chips that narrow the list, and says what 'catalogued' means", async () => {
    fj.json = raw
    const c = render(<CandyCollectionsProgress wallet={WALLET} collection="candy-mlb" />)
    await waitFor(() => expect(c.queryByTestId("candy-collections-progress-brands")).not.toBeNull())
    const text = c.getByTestId("candy-collections-progress").textContent!
    expect(text).toContain("4 of the 398 Candy collections RPC tracks")
    expect(text).toContain("5 of 5 catalogued · all")
    expect(text).toContain("40 of 125 catalogued")
    const chips = [...c.getByTestId("candy-collections-progress-brands").querySelectorAll("button")]
    expect(chips.map((b) => b.textContent)).toEqual(["All · 4", "DC · 2", "MLB · 1"])
    fireEvent.click(chips[2])
    const names = () => [...c.container.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent)
    expect(names()).toEqual(["2026 MLB Base Series ICONs"])
    expect(chips[2].getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(chips[0])
    expect(names()).toHaveLength(4)
    expect(c.container.querySelector('a[href="/candy-mlb/set/batman-1"]')).not.toBeNull()
    expect(c.container.textContent?.toLowerCase()).not.toContain("property")
  })
  it("a failed read says so and an empty wallet says that — two different sentences", async () => {
    fj.ok = false
    const failed = render(<CandyCollectionsProgress wallet={WALLET} collection="candy-mlb" />)
    await waitFor(() => expect(failed.queryByTestId("candy-collections-progress-failed")).not.toBeNull())
    expect(failed.getByTestId("candy-collections-progress-failed").textContent).toContain("does not mean the wallet holds nothing")
    expect(failed.queryByTestId("candy-collections-progress-empty")).toBeNull()
    cleanup()
    fj.ok = true
    fj.json = { collections_total: 398, collections: [] }
    const empty = render(<CandyCollectionsProgress wallet={WALLET} collection="candy-mlb" />)
    await waitFor(() => expect(empty.queryByTestId("candy-collections-progress-empty")).not.toBeNull())
    expect(empty.queryByTestId("candy-collections-progress-failed")).toBeNull()
  })
  const req = (q: string) => ({ nextUrl: new URL(`https://t/api/candy-collections-progress?${q}`) }) as never
  it("the API passes a Solana key through untouched and refuses anything else before a read", async () => {
    db.res = { data: raw, error: null }
    const res = await GET(req(`wallet=${WALLET}`))
    expect(res.status).toBe(200)
    expect(db.calls).toEqual([["candy_wallet_collection_progress", { p_wallet: WALLET }]])
    expect((await res.json()).collections).toHaveLength(4)
    db.calls.length = 0
    expect((await GET(req("wallet=0xbd94cade097e50ac"))).status).toBe(400)
    expect((await GET(req("wallet="))).status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })
  it("a failed or malformed read is a server error, never an empty list; the route is anon-public for GET only", async () => {
    db.res = { data: null, error: { message: "boom", code: "57014" } }
    const failed = await GET(req(`wallet=${WALLET}`))
    expect(failed.status).toBeGreaterThanOrEqual(500)
    expect(await failed.json()).not.toHaveProperty("collections")
    db.res = { data: [], error: null }
    expect((await GET(req(`wallet=${WALLET}`))).status).toBeGreaterThanOrEqual(500)
    expect(isPublicPath("/api/candy-collections-progress", "GET")).toBe(true)
    expect(isPublicPath("/api/candy-collections-progress", "POST")).toBe(false)
  })
})
