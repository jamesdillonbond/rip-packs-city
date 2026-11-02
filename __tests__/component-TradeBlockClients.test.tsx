// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"

// The Trade Block's three client surfaces (2026-11-02). Each keeps its states apart:
// a failed read is a banner with Retry — never "no listings" / "holds nothing" — and an
// account RPC has not indexed reads "not indexed yet". No wallet address is rendered on
// a public surface; FMV renders only where priced ("not priced" otherwise, never $0).

const wallet = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock("@/lib/trade-room/trade-wallet", () => ({ connectTradeWalletWithProof: wallet.connect }))

import BlockBrowseClient from "@/app/trades/block/BlockBrowseClient"
import ListingClient from "@/app/trades/block/[code]/ListingClient"
import BlockMineClient from "@/app/trades/block/mine/BlockMineClient"

type Answer = { status: number; body: unknown }
let answers: Record<string, Answer | ((init?: RequestInit) => Answer)>
let calls: Array<{ key: string; body: unknown }>

function installFetch() {
  calls = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const key = `${init?.method ?? "GET"} ${url}`
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : null })
    const a = answers[key] ?? answers[`${init?.method ?? "GET"} ${url.split("?")[0]}*`]
    if (!a) throw new Error(`unexpected fetch ${key}`)
    const r = typeof a === "function" ? a(init) : a
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response
  }) as typeof fetch
}

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"

const line = (o: Record<string, unknown> = {}) => ({
  collection_id: TS,
  collection: "NBA Top Shot",
  asset_noun: "Moment",
  person_noun: "player",
  kind: "moment",
  moment_id: "1",
  edition_key: "1:2",
  player_name: "Victor Wembanyama",
  set_name: "Base Set",
  tier: "COMMON",
  series_number: 7,
  serial_number: 42,
  image_url: null,
  fmv_usd: 40,
  priced: true,
  in_index: true,
  ...o,
})

const listing = (o: Record<string, unknown> = {}) => ({
  code: "abcdefghij",
  username: "webz_80",
  is_mine: false,
  state: "open",
  note: "Looking for Spurs rookies",
  open_to_offers: true,
  created_at: "2026-11-02T16:00:00Z",
  expires_at: "2026-12-02T16:00:00Z",
  offers: [line(), line({ moment_id: "2", player_name: "Stephon Castle", fmv_usd: null, priced: false, in_index: false })],
  wants: [line({ kind: "player", moment_id: null, player_name: "Josh Allen", collection_id: AD, collection: "NFL All Day", fmv_usd: null, priced: false, in_index: null })],
  collections: ["NBA Top Shot", "NFL All Day"],
  value: { count: 2, priced: 1, unpriced: 1, priced_total_usd: 40, complete: false },
  ...o,
})

beforeEach(() => {
  answers = {}
  installFetch()
  wallet.connect.mockReset()
})
afterEach(cleanup)

describe("BlockBrowseClient", () => {
  it("renders listings with priced and unpriced lines, never $0 and never a wallet", async () => {
    answers["GET /api/public/trade-block"] = { status: 200, body: { listings: [listing()], next_before: null } }
    const { container } = render(<BlockBrowseClient />)
    expect(screen.getByText(/Loading the Trade Block/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText("webz_80")).toBeTruthy())
    expect(screen.getByText("$40.00")).toBeTruthy()
    expect(screen.getByText("not priced")).toBeTruthy()
    expect(screen.getByText(/May have moved/)).toBeTruthy()
    expect(screen.getByText("Any Josh Allen")).toBeTruthy()
    expect(container.textContent).not.toMatch(/\$0\.00|0x[0-9a-f]{16}/)
  })

  it("a failed read is a banner with Retry, never 'no listings'", async () => {
    answers["GET /api/public/trade-block"] = { status: 503, body: { error: "The Trade Block isn't available right now." } }
    render(<BlockBrowseClient />)
    await waitFor(() => expect(screen.getByText(/Couldn't load the Trade Block/)).toBeTruthy())
    expect(screen.queryByText(/No open listings/)).toBeNull()
    answers["GET /api/public/trade-block"] = { status: 200, body: { listings: [], next_before: null } }
    fireEvent.click(screen.getByText("Retry"))
    await waitFor(() => expect(screen.getByText(/No open listings yet/)).toBeTruthy())
  })

  it("filters by collection and player and pages with the cursor", async () => {
    answers["GET /api/public/trade-block"] = { status: 200, body: { listings: [listing()], next_before: "2026-11-02T16:00:00Z" } }
    answers["GET /api/public/trade-block?collection=nfl-all-day&q=allen"] = { status: 200, body: { listings: [], next_before: null } }
    answers["GET /api/public/trade-block?before=2026-11-02T16%3A00%3A00Z"] = { status: 200, body: { listings: [listing({ code: "zzzzzzzzzz", username: "sdb" })], next_before: null } }
    render(<BlockBrowseClient />)
    await waitFor(() => expect(screen.getByText("Load more")).toBeTruthy())
    fireEvent.click(screen.getByText("Load more"))
    await waitFor(() => expect(screen.getByText("sdb")).toBeTruthy())
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "nfl-all-day" } })
    fireEvent.change(screen.getByPlaceholderText("e.g. Wembanyama"), { target: { value: "allen" } })
    fireEvent.click(screen.getByText("Search"))
    await waitFor(() => expect(screen.getByText(/No open listings match that search/)).toBeTruthy())
  })
})

describe("ListingClient", () => {
  it("anon sees the listing and a sign-in prompt, not a proposal form", async () => {
    answers["GET /api/public/trade-block/abcdefghij"] = { status: 200, body: { listing: listing(), signed_in: false } }
    render(<ListingClient code="abcdefghij" />)
    await waitFor(() => expect(screen.getByText(/webz_80's listing/)).toBeTruthy())
    expect(screen.getByText("Sign in")).toBeTruthy()
    expect(screen.queryByText("Propose a trade")).toBeNull()
  })

  it("an unknown code is 'no such listing'; a failed read is a Retry banner", async () => {
    answers["GET /api/public/trade-block/abcdefghij"] = { status: 404, body: { error: "No such listing." } }
    render(<ListingClient code="abcdefghij" />)
    await waitFor(() => expect(screen.getByText(/No such listing/)).toBeTruthy())
    cleanup()
    answers["GET /api/public/trade-block/abcdefghij"] = { status: 503, body: { error: "down" } }
    render(<ListingClient code="abcdefghij" />)
    await waitFor(() => expect(screen.getByText(/Couldn't load this listing/)).toBeTruthy())
  })

  it("a signed-in collector proposes from their holdings", async () => {
    answers["GET /api/public/trade-block/abcdefghij"] = { status: 200, body: { listing: listing(), signed_in: true } }
    answers["GET /api/trade-block*"] = {
      status: 200,
      body: { holdings: { proven: true, indexed: true, truncated: false, rows: [{ collection_id: AD, moment_id: "7", source: "0x00000000000000bc", edition_key: "4790", player_name: "Josh Allen", set_name: "Base", tier: "RARE", series_number: 1, serial_number: 3, image_url: null, fmv_usd: 12 }] } },
    }
    answers["POST /api/trade-block"] = { status: 201, body: { proposal: { code: "pppppppppp" } } }
    render(<ListingClient code="abcdefghij" />)
    await waitFor(() => expect(screen.getByText("Propose a trade")).toBeTruthy())
    fireEvent.click(screen.getByText("Propose a trade"))
    await waitFor(() => expect(screen.getAllByText("Josh Allen").length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText("Josh Allen")[0].closest("button") as HTMLElement)
    fireEvent.click(screen.getAllByText("Victor Wembanyama")[1].closest("button") as HTMLElement)
    fireEvent.click(screen.getByText("Send proposal"))
    await waitFor(() => expect(screen.getByText(/Proposal sent/)).toBeTruthy())
    const sent = calls.find((c) => c.key === "POST /api/trade-block")!.body as { give: unknown[]; get: unknown[] }
    expect(sent.give).toEqual([{ collection_id: AD, moment_id: "7" }])
    expect(sent.get).toEqual([{ collection_id: TS, moment_id: "1" }])
  })

  it("no proven account: points to My Trade Block instead of saying 'holds nothing'", async () => {
    answers["GET /api/public/trade-block/abcdefghij"] = { status: 200, body: { listing: listing(), signed_in: true } }
    answers["GET /api/trade-block*"] = { status: 200, body: { holdings: { proven: false, indexed: false, rows: [], truncated: false } } }
    render(<ListingClient code="abcdefghij" />)
    await waitFor(() => expect(screen.getByText("Propose a trade")).toBeTruthy())
    fireEvent.click(screen.getByText("Propose a trade"))
    await waitFor(() => expect(screen.getByText(/Prove a Flow Wallet/)).toBeTruthy())
  })
})

type Mine = { wallets: unknown[]; listings: unknown[]; proposals: { received: Array<Record<string, unknown>>; sent: Array<Record<string, unknown>> } }
const mine = (o: Record<string, unknown> = {}): Mine => ({
  wallets: [{ source: "0xbd94cade097e50ac", signer: "0x3d0b274c80263484", proven_at: "2026-11-02T16:00:00Z" }],
  listings: [listing({ is_mine: true })],
  proposals: {
    received: [
      {
        code: "pppppppppp",
        listing_code: "abcdefghij",
        counterparty: "ThunderHour",
        direction: "received",
        status: "pending",
        note: null,
        created_at: "2026-11-02T16:30:00Z",
        decided_at: null,
        room_code: null,
        give: [line({ moment_id: "9", player_name: "Anthony Edwards" })],
        get: [line()],
        give_value: { count: 1, priced: 1, unpriced: 0, priced_total_usd: 30, complete: true },
        get_value: { count: 1, priced: 1, unpriced: 0, priced_total_usd: 40, complete: true },
        unsignable: [],
      },
    ],
    sent: [],
  },
  ...o,
})

describe("BlockMineClient", () => {
  it("a failed read is a Retry banner, never 'no listings'", async () => {
    answers["GET /api/trade-block"] = { status: 503, body: { error: "down" } }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText(/Couldn't load your Trade Block/)).toBeTruthy())
    expect(screen.queryByText(/No listings yet/)).toBeNull()
  })

  it("accepting an all-Top-Shot proposal links the trade room", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine() }
    const accepted = mine()
    accepted.proposals.received[0] = { ...accepted.proposals.received[0], status: "accepted", room_code: "rrrrrrrrrr", decided_at: "2026-11-02T17:00:00Z" }
    answers["POST /api/trade-block"] = { status: 200, body: { room_code: "rrrrrrrrrr", unsignable: [], ...accepted } }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("From ThunderHour")).toBeTruthy())
    expect(screen.getByText(/accepting opens a trade room/)).toBeTruthy()
    fireEvent.click(screen.getByText("Accept"))
    await waitFor(() => expect(screen.getByText("Open the trade room →")).toBeTruthy())
    expect(screen.getByText(/a trade room is open: \/trades\/rrrrrrrrrr/)).toBeTruthy()
  })

  it("an accepted cross-collection proposal says nothing moves", async () => {
    const m = mine()
    m.proposals.received[0] = { ...m.proposals.received[0], status: "accepted", unsignable: ["NFL All Day"], decided_at: "2026-11-02T17:00:00Z" }
    answers["GET /api/trade-block"] = { status: 200, body: m }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText(/NFL All Day isn't supported yet/)).toBeTruthy())
  })

  it("with no proven account it offers the proof, and proving a single account saves it", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine({ wallets: [], listings: [], proposals: { sent: [], received: [] } }) }
    answers["GET /api/trade-block?nonce=1"] = { status: 200, body: { nonce: "a".repeat(64), issuedAt: "2026-11-02T16:00:00Z" } }
    let n = 0
    answers["POST /api/trade-block"] = () =>
      ++n === 1 ? { status: 200, body: { signer: "0x3d0b274c80263484", accounts: [{ address: "0x3d0b274c80263484", role: "flow_wallet", name: null, dapper: false }] } } : { status: 200, body: mine() }
    wallet.connect.mockResolvedValue({ address: "0x3d0b274c80263484", proof: { address: "0x3d0b274c80263484", nonce: "a".repeat(64), signatures: [] } })
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("Connect Flow Wallet")).toBeTruthy())
    expect(screen.queryByText("Post a listing")).toBeNull()
    fireEvent.click(screen.getByText("Connect Flow Wallet"))
    await waitFor(() => expect(screen.getByText("Post a listing")).toBeTruthy())
    const saves = calls.filter((c) => c.key === "POST /api/trade-block").map((c) => c.body as { action: string; source?: string })
    expect(saves.map((s) => s.source ?? null)).toEqual([null, "0x3d0b274c80263484"])
  })

  it("posts a listing from holdings with a player want", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine({ listings: [], proposals: { sent: [], received: [] } }) }
    answers["GET /api/trade-block*"] = {
      status: 200,
      body: { holdings: { indexed: true, truncated: false, rows: [{ collection_id: TS, moment_id: "1", source: "0xbd94cade097e50ac", edition_key: "1:2", player_name: "Victor Wembanyama", set_name: "Base", tier: "COMMON", series_number: 7, serial_number: 42, image_url: null, fmv_usd: 40 }] } },
    }
    answers["POST /api/trade-block"] = { status: 201, body: { listing: { code: "newlisting" } } }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("Post a listing")).toBeTruthy())
    fireEvent.click(screen.getByText("Post a listing"))
    await waitFor(() => expect(screen.getByText("Victor Wembanyama")).toBeTruthy())
    fireEvent.click(screen.getByText("Victor Wembanyama").closest("button") as HTMLElement)
    fireEvent.click(screen.getByText("Any of a player or character"))
    fireEvent.change(screen.getByPlaceholderText("Player name"), { target: { value: "Cooper Flagg" } })
    fireEvent.click(screen.getByText("Add"))
    expect(screen.getByText("Any Cooper Flagg")).toBeTruthy()
    fireEvent.click(screen.getByText("Post listing"))
    await waitFor(() => expect(screen.getByText(/Posted\. Your listing is live/)).toBeTruthy())
    const body = calls.find((c) => c.key === "POST /api/trade-block")!.body as { offers: unknown[]; wants: unknown[] }
    expect(body.offers).toEqual([{ collection_id: TS, moment_id: "1" }])
    expect(body.wants).toEqual([{ kind: "player", collection_id: TS, player_name: "Cooper Flagg" }])
  })
})
