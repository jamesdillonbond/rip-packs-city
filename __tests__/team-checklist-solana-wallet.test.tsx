// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import TeamChecklist from "@/components/entity/TeamChecklist"
import TeamSets from "@/components/entity/TeamSets"
import { parseChecklistWallet, checklistWalletStorageKey } from "@/lib/entity/checklist-wallet"

/**
 * Team checklist on a SOLANA collection (Candy MLB). Until 2026-09-25 every
 * layer forced `/^0x[0-9a-f]{16}$/` on a lowercased value, so a Candy holder's
 * key was refused on paste — and a folded base58 key matches nothing in the
 * exact-match RPC, reading "0 owned". Stated as the ABSENCE of the false claim:
 * the key reaches the API unfolded, a Flow key is refused on a Solana page, no
 * Flow warm-up is fired, and no "Indexing…" promise is made that nothing keeps.
 * The Flow arms are pinned as their own no-change cases.
 */

vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

// A real-shaped base58 key with mixed case — the property under test.
const SOL = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix"
const FLOW = "0x0123456789abcdef"

describe("parseChecklistWallet", () => {
  it("passes a Solana key VERBATIM on a Solana collection — never folded", () => {
    const p = parseChecklistWallet(`  ${SOL} `, "solana")
    expect(p).toEqual({ ok: true, wallet: SOL })
    expect(p.ok && p.wallet).not.toBe(SOL.toLowerCase())
  })
  it("REFUSES a Flow key on a Solana collection instead of tracking nothing", () => {
    const p = parseChecklistWallet(FLOW, "solana")
    expect(p.ok).toBe(false)
  })
  it("no-change arm: Flow keeps lowercase 0x+16hex and silently drops anything else", () => {
    expect(parseChecklistWallet("0x0123456789ABCDEF", "flow")).toEqual({ ok: true, wallet: FLOW })
    expect(parseChecklistWallet(SOL, "flow")).toEqual({ ok: true, wallet: null })
    expect(parseChecklistWallet("junk", undefined)).toEqual({ ok: true, wallet: null })
    expect(parseChecklistWallet(null, "flow")).toEqual({ ok: true, wallet: null })
  })
  it("Flow keeps the historical storage slot; Solana gets its own", () => {
    expect(checklistWalletStorageKey("flow")).toBe("rpc_checklist_wallet")
    expect(checklistWalletStorageKey(undefined)).toBe("rpc_checklist_wallet")
    expect(checklistWalletStorageKey("solana")).not.toBe("rpc_checklist_wallet")
  })
})

const res = (ok: boolean, body: unknown) =>
  Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response)
const tile = {
  route_slug: "aaron-judge", player_name: "Aaron Judge", team_name: "New York Yankees",
  set_name: "2026 MLB Base Series ICONs", tier: "COMMON", series_num: 1, series_label: "Series 1",
  fmv_usd: 5, floor_usd: 2.5, circulation_count: 250, thumbnail_url: null, owned: false,
}
const prog = (over: Record<string, unknown> = {}) => ({
  total: 7, owned: 0, missing_count: 7, completion_pct: null, cost_to_complete_usd: 6.54,
  stale_missing_pct: null, wallet_cached: false, scope: "all_time",
  by_tier: [{ tier: "COMMON", total: 7, owned: 0, cost_usd: 6.54 }], ...over,
})

let calls: string[] = []
function stubFetch(progress: (url: string) => unknown) {
  calls = []
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    calls.push(String(url))
    if (url.includes("team-checklist-progress")) return res(true, progress(url))
    if (url.includes("wallet-search")) return res(true, {})
    return res(true, [tile])
  }))
}

beforeEach(() => window.localStorage.clear())
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("TeamChecklist on Candy MLB (Solana)", () => {
  it("a pasted base58 key reaches the API unfolded and persists in the Solana slot", async () => {
    stubFetch((u) => prog(u.includes("wallet=") ? { owned: 7, completion_pct: 100, wallet_cached: true } : {}))
    const { getByPlaceholderText, getByText } = render(<TeamChecklist collectionUrlSlug="candy-mlb" teamSlug="new-york-yankees" />)
    await waitFor(() => expect(getByText("7 editions")).toBeTruthy())
    fireEvent.change(getByPlaceholderText("Solana wallet…"), { target: { value: SOL } })
    fireEvent.submit(getByPlaceholderText("Solana wallet…").closest("form")!)
    await waitFor(() => expect(getByText("7 / 7")).toBeTruthy())
    const withWallet = calls.filter((u) => u.includes("wallet="))
    expect(withWallet.length).toBeGreaterThan(0)
    for (const u of withWallet) {
      expect(new URL(u, "https://t").searchParams.get("wallet")).toBe(SOL)
    }
    expect(window.localStorage.getItem(checklistWalletStorageKey("solana"))).toBe(SOL)
    expect(window.localStorage.getItem("rpc_checklist_wallet")).toBeNull()
  })

  it("refuses a Flow key on a Solana page — no wallet request is made", async () => {
    stubFetch(() => prog())
    const { getByPlaceholderText, getByText, queryByText } = render(<TeamChecklist collectionUrlSlug="candy-mlb" teamSlug="new-york-yankees" />)
    await waitFor(() => expect(getByText("7 editions")).toBeTruthy())
    fireEvent.change(getByPlaceholderText("Solana wallet…"), { target: { value: FLOW } })
    fireEvent.submit(getByPlaceholderText("Solana wallet…").closest("form")!)
    await waitFor(() => expect(getByText(/Solana wallet address/)).toBeTruthy())
    expect(queryByText(/0x Flow address/)).toBeNull()
    expect(calls.some((u) => u.includes("wallet="))).toBe(false)
  })

  it("an UNCACHED Solana key fires no Flow warm-up and promises no indexing", async () => {
    window.localStorage.setItem(checklistWalletStorageKey("solana"), SOL)
    stubFetch(() => prog({ wallet_cached: false }))
    const { findByText, queryByText } = render(<TeamChecklist collectionUrlSlug="candy-mlb" teamSlug="new-york-yankees" />)
    await findByText(/no cards indexed for this wallet/)
    expect(queryByText(/Indexing your collection/)).toBeNull()
    expect(calls.some((u) => u.includes("wallet-search"))).toBe(false)
  })

  it("a Flow key saved by a Top Shot page is never restored onto a Candy page", async () => {
    window.localStorage.setItem("rpc_checklist_wallet", FLOW)
    stubFetch(() => prog())
    const { getByText } = render(<TeamChecklist collectionUrlSlug="candy-mlb" teamSlug="new-york-yankees" />)
    await waitFor(() => expect(getByText("7 editions")).toBeTruthy())
    expect(calls.some((u) => u.includes("wallet="))).toBe(false)
  })
})

describe("TeamSets on Candy MLB (Solana)", () => {
  it("reads the checklist's Solana slot and sends the key unfolded", async () => {
    window.localStorage.setItem(checklistWalletStorageKey("solana"), SOL)
    stubFetch(() => ({}))
    render(<TeamSets collectionUrlSlug="candy-mlb" teamSlug="new-york-yankees" initial={[]} initialOk={true} />)
    await waitFor(() => expect(calls.some((u) => u.includes("team-sets"))).toBe(true))
    const u = calls.find((c) => c.includes("team-sets"))!
    expect(new URL(u, "https://t").searchParams.get("wallet")).toBe(SOL)
  })
  it("never sends a Flow key saved by a Top Shot page", async () => {
    window.localStorage.setItem("rpc_checklist_wallet", FLOW)
    stubFetch(() => ({}))
    render(<TeamSets collectionUrlSlug="candy-mlb" teamSlug="new-york-yankees" initial={[]} initialOk={true} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.some((c) => c.includes("team-sets"))).toBe(false)
  })
})
