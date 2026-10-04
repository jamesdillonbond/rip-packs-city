// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import GiveawayClient, { defaultDestination } from "@/app/giveaways/[slug]/GiveawayClient"

const { connectClaimWallet, disconnectClaimWallet } = vi.hoisted(() => ({
  connectClaimWallet: vi.fn(),
  disconnectClaimWallet: vi.fn(),
}))
vi.mock("@/lib/giveaways/claim-wallet", () => ({ connectClaimWallet, disconnectClaimWallet }))

// The public giveaway page. What matters for a claimer: the four load states are never
// collapsed (a failed read is not "no such giveaway"), a claim failure shows the route's
// OWN copy (and a generic line when the body is not our JSON), and the fairness proof is
// only offered once the salt is public.

const BASE = {
  drop: {
    slug: "fall-drop",
    title: "Fall drop",
    description: "Three packs for the fam",
    sponsor_name: "Trevor",
    status: "open",
    pack_count: 3,
    moments_per_pack: 2,
    claimed_count: 1,
    seal_hash: "a".repeat(64),
    sealed_at: "2026-09-29T19:00:00Z",
    opened_at: "2026-09-29T19:05:00Z",
    closed_at: null,
  },
  pool: [
    { moment_id: "1", player_name: "Damian Lillard", set_name: "Base Set", team_name: null, tier: "rare", serial_number: 7, fmv_usd: 9.5, image_url: null },
    { moment_id: "2", player_name: null, set_name: null, team_name: null, tier: null, serial_number: null, fmv_usd: null, image_url: null },
  ],
  values: { pool_fmv_usd: 9.5, unpriced_count: 1, mean_pack_usd: null, median_pack_usd: null, best_pack_usd: null },
  verification: null,
  me: null,
  signed_in: true,
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe("GiveawayClient — load states", () => {
  it("shows loading, then the drop", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(BASE)))
    render(<GiveawayClient slug="fall-drop" />)
    expect(screen.getByText(/Loading the giveaway/)).toBeTruthy()
    expect(await screen.findByText("Fall drop")).toBeTruthy()
    expect(screen.getByText(/Open · 2 of 3 packs left/)).toBeTruthy()
    expect(screen.getByText("Three packs for the fam")).toBeTruthy()
    // an unpriced moment and absent pack values are dashes, never $0
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
    expect(screen.queryByText("$0.00")).toBeNull()
    expect(screen.getByText("Unknown player")).toBeTruthy()
  })

  it("a 404 is 'not found' — a different message from a failed read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "No such giveaway." }, 404)))
    render(<GiveawayClient slug="nope" />)
    expect(await screen.findByText("Giveaway not found")).toBeTruthy()
    expect(screen.queryByText(/Couldn.t load/)).toBeNull()
  })

  it("a failed read says so and can retry", async () => {
    const fetchMock = vi.fn(async () => json({ error: "x" }, 503))
    vi.stubGlobal("fetch", fetchMock)
    render(<GiveawayClient slug="fall-drop" />)
    expect(await screen.findByText(/Couldn.t load this giveaway/)).toBeTruthy()
    expect(screen.queryByText("Giveaway not found")).toBeNull()
    fetchMock.mockImplementationOnce(async () => json(BASE))
    fireEvent.click(screen.getByRole("button", { name: /try again/i }))
    expect(await screen.findByText("Fall drop")).toBeTruthy()
  })

  it("a network failure is the failed-read state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))))
    render(<GiveawayClient slug="fall-drop" />)
    expect(await screen.findByText(/Couldn.t load this giveaway/)).toBeTruthy()
  })
})

describe("GiveawayClient — claiming", () => {
  it("signed out: a sign-in link back to this giveaway, no form", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...BASE, signed_in: false })))
    render(<GiveawayClient slug="fall-drop" />)
    const link = await screen.findByRole("link", { name: /sign in to claim/i })
    expect(link.getAttribute("href")).toBe("/login?next=%2Fgiveaways%2Ffall-drop")
    expect(screen.queryByPlaceholderText("username")).toBeNull()
  })

  it("the claim button stays disabled until the rules box is ticked and a username entered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(BASE)))
    render(<GiveawayClient slug="fall-drop" />)
    const button = (await screen.findByRole("button", { name: /claim my pack/i })) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText("username"), { target: { value: "alice" } })
    expect(button.disabled).toBe(true)
    fireEvent.click(screen.getByRole("checkbox"))
    expect(button.disabled).toBe(false)
  })

  it("a successful claim posts the username + agreement and reloads into 'Your pack'", async () => {
    const mine = {
      ...BASE,
      me: {
        pack_no: 2,
        topshot_username: "alice",
        claimed_at: "2026-09-29T19:40:00Z",
        moments: [
          { ...BASE.pool[0], slot: 1, delivered: true, last_checked_at: "2026-09-29T20:00:00Z" },
          { ...BASE.pool[1], moment_id: "3", slot: 2, delivered: false, last_checked_at: null },
        ],
      },
    }
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ ok: true, outcome: "claimed", pack_no: 2 })
      return json(fetchMock.mock.calls.length > 2 ? mine : BASE)
    })
    vi.stubGlobal("fetch", fetchMock)
    render(<GiveawayClient slug="fall-drop" />)
    fireEvent.change(await screen.findByPlaceholderText("username"), { target: { value: "alice" } })
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /claim my pack/i }))
    expect(await screen.findByText(/Your pack · #2/)).toBeTruthy()
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ username: "alice", agree: true })
    // the pack arrives SEALED; "Show all" skips straight to the delivery grid
    expect(screen.getByText("Pack #2")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Show all" }))
    expect(screen.getByText(/Delivered: in your Top Shot account/)).toBeTruthy()
    expect(screen.getByText("Awaiting the sponsor's gift")).toBeTruthy()
    // ...and stays opened for this browser
    expect(localStorage.getItem("rpc_giveaway_opened:fall-drop:2")).toBe("1")
  })

  it("a refused claim shows the route's own copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) =>
        init?.method === "POST" ? json({ ok: false, error: "Every pack has been claimed." }, 409) : json(BASE),
      ),
    )
    render(<GiveawayClient slug="fall-drop" />)
    fireEvent.change(await screen.findByPlaceholderText("username"), { target: { value: "alice" } })
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /claim my pack/i }))
    expect(await screen.findByText("Every pack has been claimed.")).toBeTruthy()
  })

  it("a non-JSON error body falls back to generic copy; a network failure says so", async () => {
    let n = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        if (init?.method !== "POST") return json(BASE)
        n += 1
        if (n === 1) return new Response("<html>502</html>", { status: 502 })
        throw new Error("offline")
      }),
    )
    render(<GiveawayClient slug="fall-drop" />)
    fireEvent.change(await screen.findByPlaceholderText("username"), { target: { value: "alice" } })
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /claim my pack/i }))
    expect(await screen.findByText(/couldn.t record your claim/i)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /claim my pack/i }))
    expect(await screen.findByText(/couldn.t reach Rip Packs City/i)).toBeTruthy()
  })

  it("no claim form when every pack is claimed, or before claims open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...BASE, drop: { ...BASE.drop, claimed_count: 3 } })))
    render(<GiveawayClient slug="fall-drop" />)
    expect(await screen.findByText(/all 3 packs claimed/)).toBeTruthy()
    expect(screen.queryByText("Claim a pack")).toBeNull()
    cleanup()
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...BASE, drop: { ...BASE.drop, status: "sealed", description: null, moments_per_pack: 1 } })))
    render(<GiveawayClient slug="fall-drop" />)
    expect(await screen.findByText(/haven't opened yet/)).toBeTruthy()
    expect(screen.queryByText("Claim a pack")).toBeNull()
    expect(screen.getByText(/packs of 2 Top Shot Moment$|3 packs of 1 Top Shot Moment/)).toBeTruthy()
  })
})

describe("GiveawayClient — provably fair", () => {
  it("before close: the fingerprint only; after close: the command that reproduces it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(BASE)))
    render(<GiveawayClient slug="fall-drop" />)
    expect(await screen.findByText(`sha256 ${"a".repeat(64)}`)).toBeTruthy()
    expect(screen.getByText(/When the giveaway closes/)).toBeTruthy()
    cleanup()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ...BASE,
          drop: { ...BASE.drop, status: "closed", closed_at: "2026-09-30T00:00:00Z" },
          verification: { salt: "b".repeat(64), manifest: "1:1,2;2:3,4;3:5,6" },
          values: { pool_fmv_usd: 30, unpriced_count: 0, mean_pack_usd: 10, median_pack_usd: 9, best_pack_usd: 12 },
        }),
      ),
    )
    render(<GiveawayClient slug="fall-drop" />)
    expect(await screen.findByText(/printf '%s' 'b{64}\|1:1,2;2:3,4;3:5,6' \| sha256sum/)).toBeTruthy()
    expect(screen.getByText("$10.00")).toBeTruthy()
    expect(screen.getByText(/Closed · 1 of 3 packs claimed/)).toBeTruthy()
  })
})

describe("GiveawayClient — claim with Flow Wallet, proven by account proof (2026-10-03)", () => {
  const FW = "0x00000000000000f1"
  const DAPPER = "0x00000000000000d2"
  const NOTS = "0x00000000000000e3"
  const NONCE = { nonce: "ab".repeat(32), issuedAt: "2026-10-03T17:00:00.000Z" }
  const PROOF = { address: FW, nonce: NONCE.nonce, signatures: [{ addr: FW, keyId: 0, signature: "cd" }] }
  const ACCOUNTS = [
    { address: FW, role: "flow_wallet", name: null, dapper: false, can_receive: true },
    { address: DAPPER, role: "linked", name: "Dapper Wallet", dapper: true, can_receive: true },
    { address: NOTS, role: "linked", name: "Creator Hub", dapper: false, can_receive: false },
  ]
  afterEach(() => {
    connectClaimWallet.mockReset()
    disconnectClaimWallet.mockReset()
  })

  type Body = Record<string, unknown>
  function routes(opts: { accounts?: () => Response; claim?: (b: Body) => Response; nonce?: () => Response } = {}) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("claim_nonce=")) return opts.nonce ? opts.nonce() : json(NONCE)
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string) as Body
        if (body.intent === "accounts") return opts.accounts ? opts.accounts() : json({ wallet: FW, accounts: ACCOUNTS })
        return opts.claim ? opts.claim(body) : json({ ok: true, outcome: "claimed", pack_no: 1 })
      }
      return json(BASE)
    })
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }
  const posts = (m: ReturnType<typeof routes>) =>
    m.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST").map((c) => JSON.parse((c[1] as RequestInit).body as string) as Body)
  const connect = async () => fireEvent.click(await screen.findByRole("button", { name: "Claim with Flow Wallet" }))

  it("signs in with the server's nonce, lists the PROVEN wallet's accounts, and claims with the proof", async () => {
    connectClaimWallet.mockResolvedValue({ address: FW, proof: PROOF })
    const fetchMock = routes()
    render(<GiveawayClient slug="fall-drop" />)
    await connect()
    expect(await screen.findByText(/Where should your pack go/)).toBeTruthy()
    // the wallet signed the nonce the server issued
    expect(connectClaimWallet).toHaveBeenCalledWith(NONCE.nonce)
    expect(posts(fetchMock)[0]).toEqual({ intent: "accounts", proof: { ...PROOF, issuedAt: NONCE.issuedAt } })
    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    expect(radios.map((r) => r.value)).toEqual([FW, DAPPER, NOTS])
    expect(radios[0].checked).toBe(true)
    expect(radios[2].disabled).toBe(true)
    expect(screen.getByText(/can't receive Top Shot moments yet/i)).toBeTruthy()
    expect(screen.queryByPlaceholderText("username")).toBeNull()
    // every account by kind with its FULL address; the Dapper wallet is called out (Trevor, 2026-10-03)
    expect(screen.getByText("My Flow Wallet")).toBeTruthy()
    expect(screen.getByText("My Dapper wallet")).toBeTruthy()
    // no single-app copy on the Dapper row: RPC covers many collections (Trevor, 2026-10-03)
    expect(screen.queryByText(/Top Shot app/)).toBeNull()
    expect(screen.getByText("Linked account “Creator Hub”")).toBeTruthy()
    for (const addr of [DAPPER, NOTS]) expect(screen.getByText(addr)).toBeTruthy()
    expect(screen.getAllByText(FW).length).toBe(2) // "Signed in with" + its own row
    expect(screen.queryByText(/…/)).toBeNull()
    fireEvent.click(radios[1])
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /claim my pack/i }))
    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(2))
    // the claim carries the PROOF, never a bare wallet address
    expect(posts(fetchMock)[1]).toEqual({ proof: { ...PROOF, issuedAt: NONCE.issuedAt }, destination: DAPPER, agree: true })
  })

  it("a wallet that returns no proof is stopped before anything is sent", async () => {
    connectClaimWallet.mockResolvedValue({ address: FW, proof: null })
    const fetchMock = routes()
    render(<GiveawayClient slug="fall-drop" />)
    await connect()
    expect(await screen.findByText(/didn't send the sign-in that proves it's yours/)).toBeTruthy()
    expect(posts(fetchMock)).toHaveLength(0)
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
    expect(screen.getByPlaceholderText("username")).toBeTruthy()
  })

  it("a refused proof shows the route's own words and never lists accounts", async () => {
    connectClaimWallet.mockResolvedValue({ address: FW, proof: PROOF })
    routes({ accounts: () => json({ error: "That Flow Wallet sign-in wasn't made for your RPC account. Connect Flow Wallet again.", code: "proof_mismatch" }, 400) })
    render(<GiveawayClient slug="fall-drop" />)
    await connect()
    expect(await screen.findByText(/wasn't made for your RPC account/)).toBeTruthy()
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
  })

  it("a sign-in that expired before the claim sends them back to Connect", async () => {
    connectClaimWallet.mockResolvedValue({ address: FW, proof: PROOF })
    routes({ claim: () => json({ error: "Your Flow Wallet sign-in expired. Connect Flow Wallet again.", code: "proof_expired" }, 400) })
    render(<GiveawayClient slug="fall-drop" />)
    await connect()
    await screen.findByText(/Where should your pack go/)
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /claim my pack/i }))
    expect(await screen.findByText(/sign-in expired/)).toBeTruthy()
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Claim with Flow Wallet" })).toBeTruthy()
  })

  it("other refusals (not linked) keep the choice on screen", async () => {
    connectClaimWallet.mockResolvedValue({ address: FW, proof: PROOF })
    routes({ claim: () => json({ error: "That account isn't your Flow Wallet or an account linked to it.", code: "not_linked" }, 400) })
    render(<GiveawayClient slug="fall-drop" />)
    await connect()
    await screen.findByText(/Where should your pack go/)
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /claim my pack/i }))
    expect(await screen.findByText(/isn't your Flow Wallet or an account linked to it/)).toBeTruthy()
    expect(screen.getAllByRole("radio")).toHaveLength(3)
  })

  it("a nonce that could not be issued says so and opens no wallet", async () => {
    routes({ nonce: () => json({ error: "We couldn't start the Flow Wallet sign-in. Try again in a moment." }, 500) })
    render(<GiveawayClient slug="fall-drop" />)
    await connect()
    expect(await screen.findByText(/couldn't start the Flow Wallet sign-in/)).toBeTruthy()
    expect(connectClaimWallet).not.toHaveBeenCalled()
  })

  it("a failed account read says so — never an empty list to choose from", async () => {
    connectClaimWallet.mockResolvedValue({ address: FW, proof: PROOF })
    routes({ accounts: () => json({ error: "We couldn't reach the Flow blockchain to check your wallet. Try again in a minute.", code: "upstream_unavailable" }, 503) })
    render(<GiveawayClient slug="fall-drop" />)
    await connect()
    expect(await screen.findByText(/couldn't reach the Flow blockchain/)).toBeTruthy()
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
    expect(screen.getByPlaceholderText("username")).toBeTruthy()
  })

  it("a non-JSON account answer falls back to generic copy", async () => {
    connectClaimWallet.mockResolvedValue({ address: FW, proof: PROOF })
    routes({ accounts: () => new Response("<!DOCTYPE html>", { status: 522 }) })
    render(<GiveawayClient slug="fall-drop" />)
    await connect()
    expect(await screen.findByText(/couldn't check your Flow Wallet/)).toBeTruthy()
  })

  it("a declined connect shows why and leaves the username path", async () => {
    connectClaimWallet.mockRejectedValue(new Error("User rejected"))
    routes()
    render(<GiveawayClient slug="fall-drop" />)
    await connect()
    expect(await screen.findByText(/Flow Wallet: User rejected/)).toBeTruthy()
    expect(screen.getByPlaceholderText("username")).toBeTruthy()
  })

  it("'Use a Top Shot username instead' disconnects and brings the username box back", async () => {
    connectClaimWallet.mockResolvedValue({ address: FW, proof: PROOF })
    routes()
    render(<GiveawayClient slug="fall-drop" />)
    await connect()
    fireEvent.click(await screen.findByRole("button", { name: "Use a Top Shot username instead" }))
    expect(screen.getByPlaceholderText("username")).toBeTruthy()
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
    await vi.waitFor(() => expect(disconnectClaimWallet).toHaveBeenCalled())
  })

  it("no account can receive: nothing is chosen and the claim button stays off", async () => {
    connectClaimWallet.mockResolvedValue({ address: FW, proof: PROOF })
    routes({ accounts: () => json({ wallet: FW, accounts: [{ address: FW, role: "flow_wallet", can_receive: false }] }) })
    render(<GiveawayClient slug="fall-drop" />)
    await connect()
    await screen.findByText(/Where should your pack go/)
    fireEvent.click(screen.getByRole("checkbox"))
    expect((screen.getByRole("button", { name: /claim my pack/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("a pack claimed to a wallet is labelled 'wallet 0x…', not as a Top Shot user", async () => {
    const mine = { ...BASE, me: { pack_no: 1, topshot_username: DAPPER, claimed_at: "2026-10-03T23:00:00Z", moments: [] } }
    vi.stubGlobal("fetch", vi.fn(async () => json(mine)))
    render(<GiveawayClient slug="fall-drop" />)
    expect(await screen.findByText(DAPPER)).toBeTruthy()
    expect(screen.getByText(/^Claimed .* for/).textContent).toContain(`for wallet ${DAPPER}.`)
    expect(screen.queryByText(`@${DAPPER}`)).toBeNull()
  })

  it("defaultDestination prefers the Flow Wallet, else the first account that can receive, else none", () => {
    const fw = { address: FW, role: "flow_wallet" as const, can_receive: true }
    const dap = { address: DAPPER, role: "linked" as const, can_receive: true }
    expect(defaultDestination([dap, fw])).toBe(FW)
    expect(defaultDestination([{ ...fw, can_receive: false }, dap])).toBe(DAPPER)
    expect(defaultDestination([{ ...fw, can_receive: false }])).toBeNull()
    expect(defaultDestination([])).toBeNull()
  })
})
