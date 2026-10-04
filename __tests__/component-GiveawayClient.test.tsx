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

describe("GiveawayClient — claim with Flow Wallet (2026-10-03)", () => {
  const FW = "0x00000000000000f1"
  const DAPPER = "0x00000000000000d2"
  const NOTS = "0x00000000000000e3"
  const ACCOUNTS = [
    { address: FW, role: "flow_wallet", can_receive: true },
    { address: DAPPER, role: "linked", can_receive: true },
    { address: NOTS, role: "linked", can_receive: false },
  ]
  afterEach(() => {
    connectClaimWallet.mockReset()
    disconnectClaimWallet.mockReset()
  })

  function routes(accounts: Response | (() => Response), onPost?: (body: unknown) => Response) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return onPost ? onPost(JSON.parse(init.body as string)) : json({ ok: true, outcome: "claimed", pack_no: 1 })
      if (url.includes("accounts_for=")) return typeof accounts === "function" ? accounts() : accounts
      return json(BASE)
    })
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }

  it("connects, lists the wallet and its linked accounts, and claims to the one chosen", async () => {
    connectClaimWallet.mockResolvedValue(FW)
    const fetchMock = routes(json({ accounts: ACCOUNTS }))
    render(<GiveawayClient slug="fall-drop" />)
    fireEvent.click(await screen.findByRole("button", { name: "Claim with Flow Wallet" }))
    expect(await screen.findByText(/Where should your pack go/)).toBeTruthy()
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(`accounts_for=${FW}`))).toBe(true)
    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    expect(radios.map((r) => r.value)).toEqual([FW, DAPPER, NOTS])
    // the Flow Wallet is chosen by default; an account that cannot hold Top Shot moments is not choosable
    expect(radios[0].checked).toBe(true)
    expect(radios[2].disabled).toBe(true)
    expect(screen.getByText(/can't receive Top Shot moments yet/)).toBeTruthy()
    // the username box is gone in wallet mode
    expect(screen.queryByPlaceholderText("username")).toBeNull()
    fireEvent.click(radios[1])
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /claim my pack/i }))
    await screen.findByRole("button", { name: /claim my pack/i })
    const post = await vi.waitFor(() => {
      const p = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")
      if (!p) throw new Error("no POST yet")
      return p
    })
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ wallet: FW, destination: DAPPER, agree: true })
  })

  it("the route's refusal (not linked) is shown in its own words", async () => {
    connectClaimWallet.mockResolvedValue(FW)
    routes(json({ accounts: ACCOUNTS }), () => json({ error: "That account isn't your Flow Wallet or an account linked to it.", code: "not_linked" }, 400))
    render(<GiveawayClient slug="fall-drop" />)
    fireEvent.click(await screen.findByRole("button", { name: "Claim with Flow Wallet" }))
    await screen.findByText(/Where should your pack go/)
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /claim my pack/i }))
    expect(await screen.findByText(/isn't your Flow Wallet or an account linked to it/)).toBeTruthy()
  })

  it("a failed account read says so — never an empty list to choose from", async () => {
    connectClaimWallet.mockResolvedValue(FW)
    routes(json({ error: "We couldn't reach the Flow blockchain to check your wallet. Try again in a minute.", code: "upstream_unavailable" }, 503))
    render(<GiveawayClient slug="fall-drop" />)
    fireEvent.click(await screen.findByRole("button", { name: "Claim with Flow Wallet" }))
    expect(await screen.findByText(/couldn't reach the Flow blockchain/)).toBeTruthy()
    expect(screen.queryByText(/Where should your pack go/)).toBeNull()
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
    // the username path still works
    expect(screen.getByPlaceholderText("username")).toBeTruthy()
  })

  it("a non-JSON account answer falls back to generic copy", async () => {
    connectClaimWallet.mockResolvedValue(FW)
    routes(() => new Response("<!DOCTYPE html>", { status: 522 }))
    render(<GiveawayClient slug="fall-drop" />)
    fireEvent.click(await screen.findByRole("button", { name: "Claim with Flow Wallet" }))
    expect(await screen.findByText(/couldn't check your Flow Wallet/)).toBeTruthy()
  })

  it("a declined connect shows why and leaves the username path", async () => {
    connectClaimWallet.mockRejectedValue(new Error("User rejected"))
    routes(json({ accounts: ACCOUNTS }))
    render(<GiveawayClient slug="fall-drop" />)
    fireEvent.click(await screen.findByRole("button", { name: "Claim with Flow Wallet" }))
    expect(await screen.findByText(/Flow Wallet: User rejected/)).toBeTruthy()
    expect(screen.getByPlaceholderText("username")).toBeTruthy()
  })

  it("'Use a Top Shot username instead' disconnects and brings the username box back", async () => {
    connectClaimWallet.mockResolvedValue(FW)
    routes(json({ accounts: ACCOUNTS }))
    render(<GiveawayClient slug="fall-drop" />)
    fireEvent.click(await screen.findByRole("button", { name: "Claim with Flow Wallet" }))
    fireEvent.click(await screen.findByRole("button", { name: "Use a Top Shot username instead" }))
    expect(screen.getByPlaceholderText("username")).toBeTruthy()
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
    await vi.waitFor(() => expect(disconnectClaimWallet).toHaveBeenCalled())
  })

  it("no account can receive: nothing is chosen and the claim button stays off", async () => {
    connectClaimWallet.mockResolvedValue(FW)
    routes(json({ accounts: [{ address: FW, role: "flow_wallet", can_receive: false }] }))
    render(<GiveawayClient slug="fall-drop" />)
    fireEvent.click(await screen.findByRole("button", { name: "Claim with Flow Wallet" }))
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
