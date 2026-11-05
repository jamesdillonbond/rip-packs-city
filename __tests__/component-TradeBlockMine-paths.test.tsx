// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"

// The Trade Block's less-travelled paths: an edition want from the catalog search,
// closing a listing, declining and withdrawing proposals, a multi-account proof, and every
// refusal or failed read surfacing the route's own copy (never a silent no-op, never
// "holds nothing").

const wallet = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock("@/lib/trade-room/trade-wallet", () => ({ connectTradeWalletWithProof: wallet.connect }))

import BlockMineClient from "@/app/trades/block/mine/BlockMineClient"
import ListingClient from "@/app/trades/block/[code]/ListingClient"

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
  image_url: "https://example.test/x.jpg",
  fmv_usd: 40,
  priced: true,
  in_index: true,
  ...o,
})
const value = { count: 1, priced: 1, unpriced: 0, priced_total_usd: 40, complete: true }
const listing = (o: Record<string, unknown> = {}) => ({
  code: "abcdefghij",
  username: "webz_80",
  is_mine: true,
  state: "open",
  note: null,
  open_to_offers: false,
  created_at: "2026-11-02T16:00:00Z",
  expires_at: "2026-12-02T16:00:00Z",
  offers: [line()],
  wants: [],
  collections: ["NBA Top Shot"],
  value,
  ...o,
})
const proposal = (o: Record<string, unknown> = {}) => ({
  code: "pppppppppp",
  listing_code: "abcdefghij",
  counterparty: "ThunderHour",
  direction: "received",
  status: "pending",
  note: "fair swap",
  created_at: "2026-11-02T16:30:00Z",
  decided_at: null,
  room_code: null,
  give: [line({ moment_id: "9", player_name: "Anthony Edwards", fmv_usd: null, priced: false })],
  get: [line()],
  give_value: { count: 1, priced: 0, unpriced: 1, priced_total_usd: null, complete: false },
  get_value: value,
  unsignable: ["NFL All Day"],
  ...o,
})
const W = [{ source: "0xbd94cade097e50ac", signer: "0x3d0b274c80263484", proven_at: null }]
const mine = (o: Record<string, unknown> = {}) => ({ wallets: W, listings: [listing()], proposals: { received: [proposal()], sent: [proposal({ code: "ssssssssss", direction: "sent", counterparty: "sdb" })] }, ...o })

beforeEach(() => {
  // the matches panel on My Trade Block (v2) reads its own endpoint; default: nothing fits
  answers = { "GET /api/trade-block?matches=1": { status: 200, body: { proven: true, my_wants: 0, complete: true, matches: [] } } }
  installFetch()
  wallet.connect.mockReset()
})
afterEach(cleanup)

describe("My Trade Block — the other paths", () => {
  it("closes a listing; a refusal shows the route's copy", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine() }
    let n = 0
    answers["POST /api/trade-block"] = () => (++n === 1 ? { status: 409, body: { error: "This listing is closed." } } : { status: 200, body: mine({ listings: [listing({ state: "closed" })] }) })
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("Close listing")).toBeTruthy())
    fireEvent.click(screen.getByText("Close listing"))
    await waitFor(() => expect(screen.getByText("This listing is closed.")).toBeTruthy())
    fireEvent.click(screen.getByText("Close listing"))
    await waitFor(() => expect(screen.queryByText("Close listing")).toBeNull())
  })

  it("declines a received proposal and withdraws a sent one; an unpriced side says 'not priced'", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine() }
    answers["POST /api/trade-block"] = (init) => {
      const b = JSON.parse(String(init?.body)) as { action: string }
      if (b.action === "decide") return { status: 200, body: mine({ proposals: { received: [proposal({ status: "declined", decided_at: "x" })], sent: [proposal({ code: "ssssssssss", direction: "sent", counterparty: "sdb" })] } }) }
      return { status: 200, body: mine({ proposals: { received: [], sent: [proposal({ code: "ssssssssss", direction: "sent", counterparty: "sdb", status: "withdrawn", decided_at: "x" })] } }) }
    }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("From ThunderHour")).toBeTruthy())
    expect(screen.getAllByText(/1 not priced \(not enough sales\)/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/can't be signed on RPC yet/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText("Decline"))
    await waitFor(() => expect(screen.getByText(/Declined ·/)).toBeTruthy())
    fireEvent.click(screen.getByText("Withdraw"))
    await waitFor(() => expect(screen.getByText(/Withdrawn ·/)).toBeTruthy())
  })

  it("an accept that the route refuses keeps the proposal pending and shows why", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine() }
    answers["POST /api/trade-block"] = { status: 409, body: { error: "This proposal changed while you were answering it. Reload." } }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("Accept")).toBeTruthy())
    fireEvent.click(screen.getByText("Accept"))
    await waitFor(() => expect(screen.getByText(/changed while you were answering/)).toBeTruthy())
    expect(screen.getByText("Accept")).toBeTruthy()
  })

  it("an accept with an unsignable collection says nothing moves", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine() }
    answers["POST /api/trade-block"] = { status: 200, body: { room_code: null, unsignable: ["NFL All Day"], ...mine({ proposals: { received: [proposal({ status: "accepted", decided_at: "x" })], sent: [] } }) } }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("Accept")).toBeTruthy())
    fireEvent.click(screen.getByText("Accept"))
    await waitFor(() => expect(screen.getByText(/^Accepted\. Signing isn.t available/)).toBeTruthy())
  })

  it("a multi-account proof asks which account; a failed wallet step shows the error", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine({ listings: [], proposals: { sent: [], received: [] } }) }
    answers["GET /api/trade-block?nonce=1"] = { status: 200, body: { nonce: "b".repeat(64), issuedAt: "2026-11-02T16:00:00Z" } }
    let n = 0
    answers["POST /api/trade-block"] = () =>
      ++n === 1
        ? { status: 200, body: { accounts: [{ address: "0x3d0b274c80263484", role: "flow_wallet", name: null, dapper: false }, { address: "0x00000000000000bc", role: "linked", name: null, dapper: true }] } }
        : { status: 200, body: mine({ wallets: [...W, { source: "0x00000000000000bc", signer: "0x3d0b274c80263484", proven_at: "2026-11-02T17:00:00Z" }] }) }
    wallet.connect.mockResolvedValueOnce({ address: "0x3d0b274c80263484", proof: { address: "0x3d0b274c80263484", nonce: "b".repeat(64), signatures: [] } })
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("Prove another account")).toBeTruthy())
    fireEvent.click(screen.getByText("Prove another account"))
    await waitFor(() => expect(screen.getByText(/Dapper account ·/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Dapper account ·/))
    await waitFor(() => expect(screen.getByText(/0x0000…00bc/)).toBeTruthy())

    wallet.connect.mockResolvedValueOnce({ address: "0x3d0b274c80263484", proof: null })
    fireEvent.click(screen.getByText("Prove another account"))
    await waitFor(() => expect(screen.getByText(/didn't send the sign-in/)).toBeTruthy())
  })

  it("composer: FMV shows at any basis ('from asks' marked), and a locked asset can't be picked", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine({ listings: [], proposals: { sent: [], received: [] } }) }
    const row = { collection_id: TS, source: W[0].source, edition_key: "1:2", set_name: "Base", tier: "LEGENDARY", series_number: 7, serial_number: 56, image_url: null }
    answers["GET /api/trade-block*"] = {
      status: 200,
      body: {
        holdings: {
          indexed: true,
          truncated: false,
          rows: [
            { ...row, moment_id: "1", player_name: "Free Agent", fmv_usd: 46, fmv_from_asks: false, locked: false },
            { ...row, moment_id: "2", player_name: "Locked Legend", fmv_usd: 2880, fmv_from_asks: true, locked: true },
          ],
        },
      },
    }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("Post a listing")).toBeTruthy())
    fireEvent.click(screen.getByText("Post a listing"))
    await waitFor(() => expect(screen.getByText("Locked Legend")).toBeTruthy())
    expect(screen.getByText("$2,880.00")).toBeTruthy()
    expect(screen.getByText("from asks")).toBeTruthy()
    expect(screen.queryByText("not priced")).toBeNull()
    const locked = screen.getByText("Locked Legend").closest("button") as HTMLButtonElement
    expect(locked.disabled).toBe(true)
    expect(screen.getByText("locked")).toBeTruthy()
    fireEvent.click(locked)
    expect(screen.getByText("You'd trade (0)")).toBeTruthy()
    fireEvent.click(screen.getByText("Free Agent").closest("button") as HTMLElement)
    expect(screen.getByText("You'd trade (1)")).toBeTruthy()
  })

  it("composer: an edition want from the catalog, a failed holdings read, an unindexed account, and a refused post", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine({ listings: [], proposals: { sent: [], received: [] } }) }
    let h = 0
    answers["GET /api/trade-block*"] = () =>
      ++h === 1
        ? { status: 503, body: { error: "The Trade Block couldn't do that just now." } }
        : h === 2
          ? { status: 200, body: { holdings: { indexed: false, rows: [], truncated: false } } }
          : { status: 200, body: { holdings: { indexed: true, truncated: true, rows: [{ collection_id: TS, moment_id: "1", source: W[0].source, edition_key: "1:2", player_name: "Victor Wembanyama", set_name: "Base", tier: "COMMON", series_number: 7, serial_number: 42, image_url: null, fmv_usd: null }] } } }
    answers["GET /api/edition-search*"] = { status: 200, body: { results: [{ id: "e1", external_id: "73:2619", player_name: "LeBron James", set_name: "Base", tier: "RARE", collection_id: TS }, { id: "e2", external_id: null, player_name: "Not ours", set_name: null, tier: null, collection_id: "00000000-0000-0000-0000-000000000000" }] } }
    answers["POST /api/trade-block"] = { status: 400, body: { error: "Notes can't include payment methods." } }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("Post a listing")).toBeTruthy())
    fireEvent.click(screen.getByText("Post a listing"))
    await waitFor(() => expect(screen.getByText(/Couldn't load your assets/)).toBeTruthy())
    fireEvent.click(screen.getByText("Filter"))
    await waitFor(() => expect(screen.getByText(/hasn't indexed the accounts/)).toBeTruthy())
    fireEvent.click(screen.getByText("Filter"))
    await waitFor(() => expect(screen.getByText(/Showing 500 of your assets — unlocked first/)).toBeTruthy())
    fireEvent.click(screen.getByText("Victor Wembanyama").closest("button") as HTMLElement)

    fireEvent.change(screen.getByPlaceholderText("Search editions by player"), { target: { value: "lebron" } })
    fireEvent.click(screen.getByText("Search"))
    await waitFor(() => expect(screen.getByText(/\+ LeBron James · Base · Rare/)).toBeTruthy())
    expect(screen.queryByText(/Not ours/)).toBeNull()
    fireEvent.click(screen.getByText(/\+ LeBron James/))
    expect(screen.getByText("LeBron James · Base · Rare")).toBeTruthy()
    fireEvent.click(screen.getByText("Remove"))
    expect(screen.queryByText("LeBron James · Base · Rare")).toBeNull()
    fireEvent.click(screen.getByText(/\+ LeBron James/))

    fireEvent.click(screen.getByText("Open to other offers too"))
    fireEvent.change(screen.getByPlaceholderText(/What you're after/), { target: { value: "venmo" } })
    fireEvent.click(screen.getByText("Post listing"))
    await waitFor(() => expect(screen.getByText(/can't include payment methods/)).toBeTruthy())
    const body = calls.filter((c) => c.key === "POST /api/trade-block").at(-1)!.body as { wants: unknown[]; open_to_offers: boolean }
    expect(body.wants).toEqual([{ kind: "edition", collection_id: TS, edition_key: "73:2619" }])
    expect(body.open_to_offers).toBe(false)
    fireEvent.click(screen.getByText("Cancel"))
    expect(screen.getByText("Post a listing")).toBeTruthy()
  })

  it("an edition search that fails says so", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine({ listings: [], proposals: { sent: [], received: [] } }) }
    answers["GET /api/trade-block*"] = { status: 200, body: { holdings: { indexed: true, rows: [], truncated: false } } }
    answers["GET /api/edition-search*"] = { status: 500, body: { error: "Internal error" } }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("Post a listing")).toBeTruthy())
    fireEvent.click(screen.getByText("Post a listing"))
    await waitFor(() => expect(screen.getByText(/Nothing matches that filter/)).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText("Search editions by player"), { target: { value: "x" } })
    fireEvent.click(screen.getByText("Search"))
    await waitFor(() => expect(screen.getByText(/Couldn't search: Internal error/)).toBeTruthy())
  })
})

describe("Listing page — the other paths", () => {
  it("the owner is pointed to My Trade Block; a closed listing takes no proposals", async () => {
    answers["GET /api/public/trade-block/abcdefghij"] = { status: 200, body: { listing: listing(), signed_in: true } }
    render(<ListingClient code="abcdefghij" />)
    await waitFor(() => expect(screen.getByText(/This is your listing/)).toBeTruthy())
    cleanup()
    answers["GET /api/public/trade-block/abcdefghij"] = { status: 200, body: { listing: listing({ is_mine: false, state: "expired" }), signed_in: true } }
    render(<ListingClient code="abcdefghij" />)
    await waitFor(() => expect(screen.getByText(/This listing is expired/)).toBeTruthy())
    expect(screen.queryByText("Propose a trade")).toBeNull()
  })

  it("a refused proposal shows the route's copy; an unindexed account and a failed holdings read are their own states", async () => {
    answers["GET /api/public/trade-block/abcdefghij"] = { status: 200, body: { listing: listing({ is_mine: false }), signed_in: true } }
    let h = 0
    answers["GET /api/trade-block*"] = () =>
      ++h === 1
        ? { status: 503, body: { error: "down" } }
        : h === 2
          ? { status: 200, body: { holdings: { proven: true, indexed: false, rows: [], truncated: false } } }
          : { status: 200, body: { holdings: { proven: true, indexed: true, truncated: true, rows: [{ collection_id: TS, moment_id: "5", source: W[0].source, edition_key: "1:2", player_name: "Jalen Brunson", set_name: "Base", tier: "COMMON", series_number: 7, serial_number: 1, image_url: null, fmv_usd: 3 }] } } }
    answers["POST /api/trade-block"] = { status: 409, body: { error: "You already have a pending proposal on this listing." } }
    render(<ListingClient code="abcdefghij" />)
    await waitFor(() => expect(screen.getByText("Propose a trade")).toBeTruthy())
    fireEvent.click(screen.getByText("Propose a trade"))
    await waitFor(() => expect(screen.getByText(/Couldn't load your assets: down/)).toBeTruthy())
    fireEvent.click(screen.getByText("Retry"))
    await waitFor(() => expect(screen.getByText(/hasn't indexed the accounts you proved/)).toBeTruthy())
    fireEvent.click(screen.getByText("Cancel"))
    fireEvent.click(screen.getByText("Propose a trade"))
    await waitFor(() => expect(screen.getByText("Jalen Brunson")).toBeTruthy())
    expect(screen.getByText(/Showing 500 of your assets — unlocked first/)).toBeTruthy()
    fireEvent.click(screen.getByText("Jalen Brunson").closest("button") as HTMLElement)
    fireEvent.change(screen.getByPlaceholderText(/Anything they should know/), { target: { value: "hi" } })
    fireEvent.change(screen.getByPlaceholderText("Filter by player, character or set"), { target: { value: "brun" } })
    fireEvent.click(screen.getByText("Send proposal"))
    await waitFor(() => expect(screen.getByText(/already have a pending proposal/)).toBeTruthy())
  })
})

describe("My Trade Block — matches", () => {
  const holding = line({ moment_id: "9", player_name: "Anthony Edwards" })
  it("lists matches, two-way first, with what fits on each side", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine({ listings: [], proposals: { sent: [], received: [] } }) }
    answers["GET /api/trade-block?matches=1"] = {
      status: 200,
      body: {
        proven: true,
        my_wants: 1,
        complete: false,
        matches: [
          { listing: listing({ is_mine: false, username: "sdb", code: "mmmmmmmmmm" }), you_hold: [holding], they_offer: [line()], two_way: true },
          { listing: listing({ is_mine: false, username: "zz", code: "nnnnnnnnnn" }), you_hold: [holding], they_offer: [], two_way: false },
        ],
      },
    }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText("Two-way")).toBeTruthy())
    expect(screen.getAllByText("They want — you hold")).toHaveLength(2)
    expect(screen.getAllByText("They offer — you want")).toHaveLength(1)
    expect(screen.getAllByText(/See the listing & propose/)[0].closest("a")?.getAttribute("href")).toBe("/trades/block/mmmmmmmmmm")
    expect(screen.getByText(/newest 300 open listings/)).toBeTruthy()
  })

  it.each([
    [{ proven: false, my_wants: 0 }, /Prove an account and post a listing/],
    [{ proven: false, my_wants: 2 }, /Prove an account to also see/],
    [{ proven: true, my_wants: 0 }, /Add wants to a listing/],
    [{ proven: true, my_wants: 2 }, /nobody wants what you hold, and nobody offers/],
  ])("an empty result explains itself by state %j", async (state, copy) => {
    answers["GET /api/trade-block"] = { status: 200, body: mine({ listings: [], proposals: { sent: [], received: [] } }) }
    answers["GET /api/trade-block?matches=1"] = { status: 200, body: { ...state, complete: true, matches: [] } }
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText(copy)).toBeTruthy())
  })

  it("a failed matches read says so with Retry, never 'nothing fits'", async () => {
    answers["GET /api/trade-block"] = { status: 200, body: mine({ listings: [], proposals: { sent: [], received: [] } }) }
    let n = 0
    answers["GET /api/trade-block?matches=1"] = () => (++n === 1 ? { status: 503, body: { error: "down" } } : { status: 200, body: { proven: true, my_wants: 1, complete: true, matches: [] } })
    render(<BlockMineClient />)
    await waitFor(() => expect(screen.getByText(/Couldn't look for matches: down/)).toBeTruthy())
    expect(screen.queryByText(/nobody wants/)).toBeNull()
    fireEvent.click(screen.getAllByText("Retry")[0])
    await waitFor(() => expect(screen.getByText(/nobody wants what you hold/)).toBeTruthy())
  })
})
