// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react"

// /trades/<code>. Drives the room through its states with a routed fetch mock and
// a mocked wallet module: load · failed read · join · prove a wallet and pick an
// account · pick Moments (chain-checked on save) · accept / withdraw · simulate ·
// the gated Sign step · co-sign · sealed. The honesty properties: a failed read is
// a banner (never "no trade"), an unindexed wallet reads as unindexed (never "no
// Moments"), and a submitted-but-unread transaction is recorded, never "failed".

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

const wallet = vi.hoisted(() => ({
  connectTradeWalletWithProof: vi.fn(),
  connectTradeWallet: vi.fn(),
  disconnectTradeWallet: vi.fn(async () => undefined),
  sendSwap: vi.fn(),
  sendMultiSwap: vi.fn(),
  coSign: vi.fn(),
  TRADE_ROOM_CADENCES: ["swap", "multi"],
  SealUnconfirmedError: class SealUnconfirmedError extends Error {
    constructor(readonly txId: string, readonly readError: string) {
      super(`unconfirmed ${txId}`)
    }
  },
}))
vi.mock("@/lib/trade-room/trade-wallet", () => wallet)

import TradeRoomClient from "@/app/trades/[code]/TradeRoomClient"
import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"
import { WITHDRAWAL_NOTICE } from "@/lib/trade-room/valuation"

const CODE = "abcdefghij"
const API = `/api/trade-room/${CODE}`
const WA = { signer: "0x3d0b274c80263484", source: "0xbd94cade097e50ac" }
const WB = { signer: "0x00000000000000bb", source: "0x00000000000000bc" }

type Answer = { status: number; body: unknown }
type Handler = Answer | ((body: Record<string, unknown>) => Answer)
let gets: Record<string, Handler>
let posts: Record<string, Handler>
let calls: Array<{ url: string; body: Record<string, unknown> | null }>

function installFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ url, body })
    const h = method === "GET" ? gets[url] : posts[String(body?.action)]
    if (!h) throw new Error(`unexpected fetch ${method} ${url} ${JSON.stringify(body)}`)
    const r = typeof h === "function" ? h(body ?? {}) : h
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response
  }) as typeof fetch
}

const item = (id: string, fmv: number | null, collection = "nba_top_shot") => ({ collection, moment_id: id, edition_key: "1:2", serial_number: Number(id), player_name: `Player ${id}`, set_name: "Set", tier: "COMMON", series_number: 8, image_url: null, fmv_usd: fmv, priced: fmv != null })

function view(o: Partial<Record<string, unknown>> = {}) {
  return {
    code: CODE,
    state: "building",
    version: 3,
    collection: "nba_top_shot",
    created_at: "2026-10-31T17:00:00Z",
    updated_at: "2026-10-31T17:05:00Z",
    expires_at: "2026-11-07T17:00:00Z",
    tx_id: null,
    sealed_at: null,
    landed: null,
    cancel_reason: null,
    cancelled_by_me: false,
    me: { side: "a", notice_read: false },
    can_join: false,
    a: { side: "a", username: "webz_80", is_me: true, signer: WA.signer, source: WA.source, proven: true, accepted: false, items: [item("1", 10)] },
    b: { side: "b", username: "ThunderHour", is_me: false, signer: WB.signer, source: WB.source, proven: true, accepted: false, items: [item("9", null)] },
    valuation: { a: { count: 1, priced: 1, unpriced: 0, priced_total_usd: 10, complete: true }, b: { count: 1, priced: 0, unpriced: 1, priced_total_usd: null, complete: false }, difference_usd: null, summary: "1 Moment not priced (not enough sales), so there is no fair-value verdict." },
    notice: WITHDRAWAL_NOTICE,
    execution: { open: false, message: "Signing is paused on RPC right now: trades can still be built and accepted here, but no wallet is asked to sign. Nothing has moved." },
    relay: null,
    from_block: null,
    ...o,
  }
}

beforeEach(() => {
  gets = {}
  posts = {}
  calls = []
  installFetch()
  vi.clearAllMocks()
})
afterEach(cleanup)

async function mount(v: ReturnType<typeof view>) {
  gets[API] = { status: 200, body: { room: v } }
  render(<TradeRoomClient code={CODE} />)
  await waitFor(() => expect(screen.queryByText(/Loading the trade/)).toBeNull())
}

describe("TradeRoomClient — loading and the failed read", () => {
  it("a 404 is 'no such trade'; another failure is a banner with Retry", async () => {
    gets[API] = { status: 404, body: { error: "No such trade.", code: "not_found" } }
    render(<TradeRoomClient code={CODE} />)
    await waitFor(() => expect(screen.getByText(/No such trade/)).toBeTruthy())
    cleanup()
    gets[API] = { status: 503, body: { error: "Something went wrong with this trade. Try again in a moment.", code: "unavailable" } }
    render(<TradeRoomClient code={CODE} />)
    await waitFor(() => expect(screen.getByText(/Couldn't load this trade: Something went wrong/)).toBeTruthy())
    gets[API] = { status: 200, body: { room: view() } }
    fireEvent.click(screen.getByText("Retry"))
    await waitFor(() => expect(screen.getByText("Building")).toBeTruthy())
  })

  it("renders both sides by username with priced / not priced Moments and the fair-trade line", async () => {
    await mount(view())
    expect(screen.getByText(/webz_80 ↔ ThunderHour/)).toBeTruthy()
    expect(screen.getByText("$10.00")).toBeTruthy()
    expect(screen.getAllByText("not priced").length).toBeGreaterThan(0)
    expect(screen.getByText(/no fair-value verdict/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/HIGH|MEDIUM|LOW/)
  })
})

describe("TradeRoomClient — joining and the invite link", () => {
  it("a stranger sees Join and the creator sees the invite link", async () => {
    const open = view({ state: "open", me: null, can_join: true, b: null, a: { ...view().a, is_me: false, items: [] } })
    await mount(open)
    posts.join = { status: 200, body: { room: view({ state: "building", me: { side: "b", notice_read: false }, b: { ...view().b!, is_me: true, proven: false, signer: null, source: null, items: [] } }) } }
    fireEvent.click(screen.getByText("Join this trade"))
    await waitFor(() => expect(screen.getByText("Building")).toBeTruthy())
    cleanup()
    const mine = view({ state: "open", b: null, a: { ...view().a, items: [] } })
    await mount(mine)
    expect(screen.getByText("Copy invite link")).toBeTruthy()
    expect(screen.getByText(/Nobody has joined yet/)).toBeTruthy()
  })
})

describe("TradeRoomClient — wallet, picks", () => {
  it("connects with a proof, lists the accounts, and saves the chosen source", async () => {
    const unproven = view({ a: { ...view().a, proven: false, signer: null, source: null, items: [] } })
    await mount(unproven)
    gets[`${API}?nonce=1`] = { status: 200, body: { nonce: "n".repeat(64), issuedAt: "2026-10-31T17:00:00Z" } }
    wallet.connectTradeWalletWithProof.mockResolvedValue({ address: WA.signer, proof: { address: WA.signer, nonce: "n".repeat(64), signatures: [] } })
    const accounts = [
      { address: WA.signer, role: "flow_wallet", name: null, dapper: false, topshot_count: 0 },
      { address: WA.source, role: "linked", name: "Dapper Wallet", dapper: true, topshot_count: 10 },
      { address: "0x00000000000000ee", role: "linked", name: "Creator Hub", dapper: false, topshot_count: null },
    ]
    posts.wallet = (body) => (body.source ? { status: 200, body: { room: view(), signer: WA.signer, accounts } } : { status: 200, body: { signer: WA.signer, accounts } })
    fireEvent.click(screen.getByText("Connect Flow Wallet"))
    await waitFor(() => expect(screen.getByText(/Which account holds the Moments/)).toBeTruthy())
    // 2026-11-02: an account with no Top Shot collection may still hold All Day / Golazos, so it
    // can be chosen; what it can give or receive is checked per collection before anyone signs.
    // It is never labelled as holding Top Shot Moments it doesn't have.
    const other = screen.getByText(/Creator Hub/).closest("button") as HTMLButtonElement
    expect(other.disabled).toBe(false)
    expect(other.textContent).not.toMatch(/Top Shot Moments/)
    fireEvent.click(screen.getByText(/Dapper Wallet/))
    await waitFor(() => expect(screen.queryByText(/Which account holds/)).toBeNull())
    const chosen = calls.find((c) => c.body?.action === "wallet" && c.body?.source)
    expect(chosen?.body?.source).toBe(WA.source)
    expect(chosen?.body?.proof).toMatchObject({ address: WA.signer, issuedAt: "2026-10-31T17:00:00Z" })
  })

  it("a wallet that sends no proof is refused on the page, and the route's refusal is shown", async () => {
    const unproven = view({ a: { ...view().a, proven: false, signer: null, source: null, items: [] } })
    await mount(unproven)
    gets[`${API}?nonce=1`] = { status: 200, body: { nonce: "n".repeat(64), issuedAt: "2026-10-31T17:00:00Z" } }
    wallet.connectTradeWalletWithProof.mockResolvedValue({ address: WA.signer, proof: null })
    fireEvent.click(screen.getByText("Connect Flow Wallet"))
    await waitFor(() => expect(screen.getByText(/didn't send the sign-in/)).toBeTruthy())
    wallet.connectTradeWalletWithProof.mockResolvedValue({ address: WA.signer, proof: { address: WA.signer, nonce: "n".repeat(64), signatures: [] } })
    posts.wallet = { status: 400, body: { error: "Flow didn't confirm that sign-in came from that wallet. Connect Flow Wallet again.", code: "proof_invalid" } }
    fireEvent.click(screen.getByText("Connect Flow Wallet"))
    await waitFor(() => expect(screen.getByText(/Flow didn't confirm/)).toBeTruthy())
  })

  it("the picker: unindexed reads as unindexed, picks toggle up to the cap, and Save sends the ids", async () => {
    await mount(view())
    gets[`${API}?picker=1&collection=nba-top-shot&q=`] = { status: 200, body: { picker: { indexed: false, rows: [], truncated: false } } }
    fireEvent.click(screen.getByText("Change picks"))
    await waitFor(() => expect(screen.getByText(/hasn't indexed that account yet/)).toBeTruthy())
    const rows = Array.from({ length: 12 }, (_, i) => ({ ...item(String(i + 1), i % 2 ? null : 5), locked_hint: i === 11, priced: i % 2 === 0 }))
    gets[`${API}?picker=1&collection=nba-top-shot&q=jokic`] = { status: 200, body: { picker: { indexed: true, rows, truncated: true } } }
    fireEvent.change(screen.getByLabelText("Filter by player"), { target: { value: "jokic" } })
    fireEvent.click(screen.getByText("Filter"))
    await waitFor(() => expect(screen.getByText(/Showing the first 12/)).toBeTruthy())
    expect(screen.getByText(/locked \(last check\)/)).toBeTruthy()
    const boxes = screen.getAllByRole("checkbox")
    // moment 1 is already saved (checked); tick 10 more, the 11th is refused at the cap
    for (let i = 1; i <= 10; i++) fireEvent.click(boxes[i])
    expect(screen.getByText(/At most 10 Moments per side/)).toBeTruthy()
    posts.items = (body) => ({ status: 200, body: { room: view({ a: { ...view().a, items: (body.picks as Array<{ id: string }>).map((p) => item(p.id, 5)) } }) } })
    fireEvent.click(screen.getByText(/Save 10 picks/))
    await waitFor(() => expect(screen.getByText(/Picks saved and checked on chain/)).toBeTruthy())
    const sent = calls.find((c) => c.body?.action === "items")?.body?.picks as Array<{ collection: string; id: string }>
    expect(sent).toHaveLength(10)
    expect(new Set(sent.map((p) => p.collection))).toEqual(new Set(["nba-top-shot"]))
  })

  it("the collection tabs read that collection; a missing collection and untradeable Moments are SAID, never 'nothing'", async () => {
    await mount(view())
    gets[`${API}?picker=1&collection=nba-top-shot&q=`] = { status: 200, body: { picker: { indexed: true, rows: [item("1", 10)], truncated: false, lock_state: "live" } } }
    fireEvent.click(screen.getByText("Change picks"))
    await waitFor(() => expect(screen.getByText(/Save 1 pick/)).toBeTruthy())
    gets[`${API}?picker=1&collection=nfl-all-day&q=`] = { status: 200, body: { picker: { indexed: true, rows: [], truncated: false, lock_state: "live", no_collection: true } } }
    fireEvent.click(screen.getByRole("tab", { name: "NFL All Day" }))
    await waitFor(() => expect(screen.getByText(/has no NFL All Day collection on chain/)).toBeTruthy())
    gets[`${API}?picker=1&collection=ufc&q=`] = {
      status: 200,
      body: { picker: { indexed: true, rows: [{ ...item("7", 3, "ufc_strike"), locked_hint: false, held_live: true }], truncated: false, lock_state: "live", not_in_collection: 12, unindexed_held: 2 } },
    }
    fireEvent.click(screen.getByRole("tab", { name: "UFC Strike" }))
    await waitFor(() => expect(screen.getByText(/12 Moments RPC lists for this account aren't in its on-chain collection/)).toBeTruthy())
    expect(screen.getByText(/2 more in this account RPC hasn't indexed yet/)).toBeTruthy()
    // a UFC pick is saved under its own collection, beside the Top Shot one already picked
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    posts.items = { status: 200, body: { room: view() } }
    fireEvent.click(screen.getByText(/Save 2 picks/))
    await waitFor(() => expect(calls.some((c) => c.body?.action === "items")).toBe(true))
    const sent = calls.find((c) => c.body?.action === "items")?.body?.picks as Array<{ collection: string; id: string }>
    expect(sent).toEqual(expect.arrayContaining([{ collection: "nba-top-shot", id: "1" }, { collection: "ufc", id: "7" }]))
  })

  it("a chain outage on save is the route's copy, not 'not held'", async () => {
    await mount(view())
    gets[`${API}?picker=1&collection=nba-top-shot&q=`] = { status: 200, body: { picker: { indexed: true, rows: [item("1", 10)], truncated: false } } }
    fireEvent.click(screen.getByText("Change picks"))
    await waitFor(() => expect(screen.getByText(/Save 1 pick/)).toBeTruthy())
    posts.items = { status: 503, body: { error: "We couldn't reach the Flow blockchain to check those Moments (HTTP 503). Try again in a minute.", code: "upstream_unavailable", retryable: true } }
    fireEvent.click(screen.getByText(/Save 1 pick/))
    await waitFor(() => expect(screen.getByText(/couldn't reach the Flow blockchain/)).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/doesn't hold/)
  })
})

describe("TradeRoomClient — accept, simulate, the gated sign step", () => {
  it("accept needs the notice read; withdraw clears it", async () => {
    await mount(view())
    const accept = screen.getByText("Accept v3") as HTMLButtonElement
    expect(accept.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/I've read this/))
    expect(accept.disabled).toBe(false)
    posts.accept = (body) => ({ status: body.version === 3 && body.notice_read === true ? 200 : 400, body: { room: view({ a: { ...view().a, accepted: true } }) } })
    fireEvent.click(accept)
    await waitFor(() => expect(screen.getByText(/You accepted v3/)).toBeTruthy())
    posts.unaccept = { status: 200, body: { room: view() } }
    fireEvent.click(screen.getByText("Withdraw"))
    await waitFor(() => expect(screen.getByText("Accept v3")).toBeTruthy())
  })

  it("an accepted room simulates, then Sign stays disabled while execution is closed and the message says why", async () => {
    const accepted = view({ state: "accepted", a: { ...view().a, accepted: true }, b: { ...view().b!, accepted: true } })
    await mount(accepted)
    expect(screen.getByText("Both accepted")).toBeTruthy()
    posts.simulate = { status: 200, body: { plan: { a: { ...WA, ids: ["1"], kind: "linked", ctl: "87" }, b: { ...WB, ids: ["9"], kind: "linked", ctl: "4" } } } }
    fireEvent.click(screen.getByText("Simulate on mainnet"))
    await waitFor(() => expect(screen.getByText(/every Moment lands/)).toBeTruthy())
    wallet.connectTradeWallet.mockResolvedValue(WA.signer)
    fireEvent.click(screen.getAllByText("Connect Flow Wallet")[0])
    await waitFor(() => expect(screen.getByText("Reconnect Flow Wallet")).toBeTruthy())
    const sign = screen.getByText("Sign and send") as HTMLButtonElement
    expect(sign.disabled).toBe(true)
    expect(screen.getByText(/Signing is paused on RPC right now/)).toBeTruthy()
    expect(wallet.sendSwap).not.toHaveBeenCalled()
  })

  it("with execution open: the initiator signs, the relay is posted, the seal is recorded; a wallet refusal ends the signing attempt", async () => {
    const accepted = view({ state: "accepted", a: { ...view().a, accepted: true }, b: { ...view().b!, accepted: true }, execution: { open: true, message: null } })
    await mount(accepted)
    posts.simulate = { status: 200, body: { plan: { a: { ...WA, ids: ["1"], kind: "linked", ctl: "87" }, b: { ...WB, ids: ["9"], kind: "linked", ctl: "4" } } } }
    fireEvent.click(screen.getByText("Simulate on mainnet"))
    await waitFor(() => expect(screen.getByText(/every Moment lands/)).toBeTruthy())
    wallet.connectTradeWallet.mockResolvedValue(WA.signer)
    fireEvent.click(screen.getAllByText("Connect Flow Wallet")[0])
    await waitFor(() => expect((screen.getByText("Sign and send") as HTMLButtonElement).disabled).toBe(false))
    const tx = "a".repeat(64)
    posts.relay_post = { status: 200, body: { id: "11111111-1111-4111-8111-111111111111" } }
    posts.sealed = { status: 200, body: { room: view({ state: "sealed", tx_id: tx, sealed_at: "2026-10-31T17:30:00Z", landed: [{ id: "1", to: WB.source, held: true }, { id: "9", to: WA.source, held: false }] }), verified: true } }
    wallet.sendSwap.mockImplementation(async (_plan: unknown, io: { post: (c: string, s: unknown) => Promise<string>; onRelay: (id: string) => void }) => {
      const id = await io.post(WB.signer, { cadence: SWAP_CADENCE })
      io.onRelay(id)
      return { txId: tx }
    })
    fireEvent.click(screen.getByText("Sign and send"))
    await waitFor(() => expect(screen.getByText("Sealed on chain", { selector: "h2" })).toBeTruthy())
    expect(calls.find((c) => c.body?.action === "relay_post")?.body).toMatchObject({ cosigner: WB.signer })
    expect(calls.find((c) => c.body?.action === "sealed")?.body).toMatchObject({ tx_id: tx })
    expect(screen.getByText(/1 is now in/)).toBeTruthy()
    expect(screen.getByText(/9 is NOT in/)).toBeTruthy()
    // a wallet refusal: the attempt is reported, signing_ended is sent, nothing is "failed on chain"
    cleanup()
    calls = []
    await mount(accepted)
    fireEvent.click(screen.getByText("Simulate on mainnet"))
    await waitFor(() => expect(screen.getByText(/every Moment lands/)).toBeTruthy())
    fireEvent.click(screen.getAllByText("Connect Flow Wallet")[0])
    await waitFor(() => expect((screen.getByText("Sign and send") as HTMLButtonElement).disabled).toBe(false))
    posts.signing_ended = { status: 200, body: { room: accepted } }
    wallet.sendSwap.mockRejectedValueOnce(new Error("User rejected the request"))
    fireEvent.click(screen.getByText("Sign and send"))
    await waitFor(() => expect(screen.getByText(/User rejected the request/)).toBeTruthy())
    expect(calls.some((c) => c.body?.action === "signing_ended")).toBe(true)
  })

  it("a submitted transaction whose seal could not be read is recorded as submitted, never 'failed'", async () => {
    const accepted = view({ state: "accepted", a: { ...view().a, accepted: true }, b: { ...view().b!, accepted: true }, execution: { open: true, message: null } })
    await mount(accepted)
    posts.simulate = { status: 200, body: { plan: { a: { ...WA, ids: ["1"], kind: "linked", ctl: "87" }, b: { ...WB, ids: [], kind: "linked", ctl: "4" } } } }
    fireEvent.click(screen.getByText("Simulate on mainnet"))
    await waitFor(() => expect(screen.getByText(/every Moment lands/)).toBeTruthy())
    wallet.connectTradeWallet.mockResolvedValue(WA.signer)
    fireEvent.click(screen.getAllByText("Connect Flow Wallet")[0])
    await waitFor(() => expect((screen.getByText("Sign and send") as HTMLButtonElement).disabled).toBe(false))
    const tx = "b".repeat(64)
    posts.sealed = { status: 200, body: { room: view({ state: "sealed", tx_id: tx, sealed_at: "2026-10-31T17:30:00Z", landed: null }), verified: false } }
    wallet.sendSwap.mockRejectedValueOnce(new wallet.SealUnconfirmedError(tx, "Load failed"))
    fireEvent.click(screen.getByText("Sign and send"))
    await waitFor(() => expect(screen.getByText(/Submitted as b+, but its result couldn't be read yet/)).toBeTruthy())
    expect(screen.getByText(/hasn't been read from the chain yet/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/failed/i)
    posts.verify = { status: 200, body: { landed: [{ id: "1", to: WB.source, held: true }], room: view({ state: "sealed", tx_id: tx, sealed_at: "x", landed: [{ id: "1", to: WB.source, held: true }] }) } }
    fireEvent.click(screen.getByText("Check the chain again"))
    await waitFor(() => expect(screen.getByText(/1 is now in/)).toBeTruthy())
  })

  it("the co-signer sees the pending relay, must connect the wallet it proved, and signs", async () => {
    const signable = { cadence: SWAP_CADENCE, args: [{ type: "Address", value: WA.source }, { type: "UInt64", value: "87" }, { type: "Array", value: [{ type: "UInt64", value: "1" }] }, { type: "Address", value: WB.source }, { type: "UInt64", value: "4" }, { type: "Array", value: [] }], message: "ab", addr: WB.signer }
    const signing = view({
      state: "signing",
      me: { side: "b", notice_read: true },
      a: { ...view().a, is_me: false, accepted: true },
      b: { ...view().b!, is_me: true, accepted: true },
      execution: { open: true, message: null },
      relay: { id: "22222222-2222-4222-8222-222222222222", cosigner: WB.signer, signable, created_at: "2026-10-31T17:20:00Z" },
    })
    await mount(signing)
    expect(screen.getByText(/needs your wallet's signature/)).toBeTruthy()
    const signBtn = () => within(screen.getByText("Sign", { selector: "h2" }).parentElement as HTMLElement).getByText("Sign", { selector: "button" }) as HTMLButtonElement
    expect(signBtn().disabled).toBe(true)
    // the wrong wallet is named, and Sign stays off
    wallet.connectTradeWallet.mockResolvedValueOnce("0x00000000000000ee")
    fireEvent.click(screen.getByText("Connect Flow Wallet"))
    await waitFor(() => expect(screen.getByText(/Connect 0x0000…00bb, the wallet you proved/)).toBeTruthy())
    expect(signBtn().disabled).toBe(true)
    wallet.connectTradeWallet.mockResolvedValueOnce(WB.signer)
    fireEvent.click(screen.getByText("Reconnect Flow Wallet"))
    await waitFor(() => expect(signBtn().disabled).toBe(false))
    wallet.coSign.mockResolvedValue({ signature: "c".repeat(128), keyId: 2 })
    posts.relay_sign = (body) => ({ status: body.key_id === 2 && body.id === "22222222-2222-4222-8222-222222222222" ? 200 : 400, body: { ok: true } })
    fireEvent.click(signBtn())
    await waitFor(() => expect(screen.getByText(/Signed\. The other side's page submits/)).toBeTruthy())
  })
})

describe("TradeRoomClient — finished rooms", () => {
  it("cancelled and expired rooms say so and offer no actions", async () => {
    await mount(view({ state: "cancelled", cancelled_by_me: true, cancel_reason: "changed my mind" }))
    expect(screen.getByText(/Cancelled by you: changed my mind/)).toBeTruthy()
    expect(screen.queryByText("Cancel this trade")).toBeNull()
    expect(screen.queryByText(/Accept v/)).toBeNull()
    cleanup()
    await mount(view({ state: "expired" }))
    expect(screen.getByText(/expired before both sides signed/)).toBeTruthy()
  })

  it("Cancel this trade sends cancel", async () => {
    await mount(view())
    posts.cancel = { status: 200, body: { room: view({ state: "cancelled", cancelled_by_me: true }) } }
    fireEvent.click(screen.getByText("Cancel this trade"))
    await waitFor(() => expect(screen.getByText(/Cancelled by you/)).toBeTruthy())
  })
})

describe("TradeRoomClient — the Trade Block guide", () => {
  it("a room opened from a proposal shows what each side agreed, as a guide", async () => {
    await mount(
      view({
        from_block: {
          listing_code: "abcdefghij",
          a_gives: [{ collection: "Top Shot", moment_id: "1", player_name: "Victor Wembanyama", set_name: "Base", serial_number: 42 }],
          b_gives: [{ collection: "UFC", moment_id: "1", player_name: "Alex Pereira", set_name: null, serial_number: 7 }],
        },
      }),
    )
    expect(screen.getByText("Agreed on the Trade Block")).toBeTruthy()
    expect(screen.getByText(/Top Shot · Victor Wembanyama · Base · #42/)).toBeTruthy()
    // the same moment id in another collection is a different Moment, and the guide says which
    expect(screen.getByText(/UFC · Alex Pereira · #7/)).toBeTruthy()
    expect(screen.getByText("The listing").getAttribute("href")).toBe("/trades/block/abcdefghij")
  })

  it("a side that gives nothing says so", async () => {
    await mount(view({ from_block: { listing_code: null, a_gives: [], b_gives: [{ collection: "All Day", moment_id: "9", player_name: "Josh Allen", set_name: null, serial_number: 3 }] } }))
    expect(screen.getByText(/gives: nothing/)).toBeTruthy()
    expect(screen.getByText(/All Day · Josh Allen · #3/)).toBeTruthy()
  })

  it("no guide without a proposal", async () => {
    await mount(view())
    expect(screen.queryByText("Agreed on the Trade Block")).toBeNull()
  })
})
