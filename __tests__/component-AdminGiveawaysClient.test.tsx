// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react"
const wallet = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  SealUnconfirmedError: class SealUnconfirmedError extends Error {
    txId: string
    constructor(txId: string, cause: string) {
      super(`Transaction ${txId} was submitted, but its result could not be read (${cause}). Do NOT send again: tap Verify deliveries.`)
      this.txId = txId
    }
  },
}))
vi.mock("@/lib/giveaways/admin-wallet", () => ({
  SealUnconfirmedError: wallet.SealUnconfirmedError,
  connectAdminWallet: () => wallet.connect(),
  disconnectAdminWallet: () => wallet.disconnect(),
  sendDeliveryBatch: (...a: unknown[]) => wallet.send(...a),
}))
import AdminGiveawaysClient from "@/app/admin/giveaways/AdminGiveawaysClient"
import { ADMIN_TOKEN_KEY } from "@/lib/admin/use-admin-resource"

// The giveaway console. What an operator must be able to trust: the moment picker lists only
// what the CHAIN confirmed giftable (and says how many the cache got wrong), an unreadable
// response is an error and never an empty list, and the Verify report names any recipient
// whose chain read failed instead of folding it into a count.

const DROP = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  slug: "fall-drop",
  title: "Fall drop",
  description: null,
  sponsor_name: "Trevor",
  collection_id: "c",
  admin_wallet: "0x00000000000000aa",
  status: "draft",
  pack_count: 1,
  moments_per_pack: 2,
  seal_hash: null,
  seal_salt: null,
  sealed_at: null,
  opened_at: null,
  closed_at: null,
  created_at: "2026-09-29T19:00:00Z",
  ...over,
})

const CANDIDATES = {
  wallet: "0x00000000000000aa",
  candidates: [
    { moment_id: "10", player_name: "Lillard", set_name: "Base", team_name: "Portland Trail Blazers", tier: "RARE", serial_number: 7, fmv_usd: 9, image_url: null, chain: "giftable" },
    { moment_id: "11", player_name: null, set_name: null, team_name: null, tier: null, serial_number: null, fmv_usd: null, image_url: null, chain: "giftable" },
  ],
  excluded: { locked: 33, not_held: 0 },
  cache_count: 35,
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
function stub(handler: Handler) {
  const f = vi.fn(async (url: string, init?: RequestInit) => handler(url, init))
  vi.stubGlobal("fetch", f)
  return f
}

beforeEach(() => {
  localStorage.setItem(ADMIN_TOKEN_KEY, "tok")
  vi.spyOn(window, "confirm").mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("AdminGiveawaysClient — token gate", () => {
  it("asks for the token, then loads with it", async () => {
    localStorage.clear()
    const f = stub(() => json({ drops: [] }))
    render(<AdminGiveawaysClient />)
    expect(screen.getByText("Admin token required.")).toBeTruthy()
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: "tok" } })
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(await screen.findByText("No drops yet.")).toBeTruthy()
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" })
  })
})

describe("AdminGiveawaysClient — building a draft", () => {
  it("lists only chain-confirmed moments, says what the cache got wrong, and creates the draft", async () => {
    let created: unknown = null
    stub((url, init) => {
      if (url.startsWith("/api/admin/giveaways?candidates=")) return json(CANDIDATES)
      if (url === "/api/admin/giveaways" && init?.method === "POST") {
        created = JSON.parse(init.body as string)
        return json({ id: "new" }, 201)
      }
      return json({ drops: [] })
    })
    render(<AdminGiveawaysClient />)
    await screen.findByText("No drops yet.")
    fireEvent.change(screen.getByPlaceholderText("username or 0x…"), { target: { value: "0x00000000000000AA" } })
    fireEvent.click(screen.getByRole("button", { name: /load giftable moments/i }))
    expect(await screen.findByText(/33 the cache called unlocked are locked on chain/)).toBeTruthy()
    expect(localStorage.getItem("rpc_giveaway_admin_wallet")).toBe("0x00000000000000aa")

    const create = screen.getByRole("button", { name: /create draft \(0\/10\)/i }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    // 1 pack of 2
    const numbers = screen.getAllByRole("spinbutton")
    fireEvent.change(numbers[0], { target: { value: "1" } })
    fireEvent.change(numbers[1], { target: { value: "2" } })
    fireEvent.click(screen.getByText("Lillard"))
    fireEvent.click(screen.getAllByText("—")[0])
    expect(screen.getByText(/1 without FMV \(sealing will refuse them\)/)).toBeTruthy()
    // toggling off and on again
    fireEvent.click(screen.getByText("Lillard"))
    fireEvent.click(screen.getByText("Lillard"))
    const inputs = screen.getAllByRole("textbox")
    fireEvent.change(inputs[1], { target: { value: "fall-drop" } })
    fireEvent.change(inputs[2], { target: { value: "Fall drop" } })
    fireEvent.change(inputs[3], { target: { value: "Trevor" } })
    fireEvent.change(screen.getByRole("textbox", { name: /description/i }), { target: { value: "hi" } })
    fireEvent.click(screen.getByRole("button", { name: /create draft \(2\/2\)/i }))
    expect(await screen.findByText("Draft created.")).toBeTruthy()
    expect(created).toMatchObject({
      slug: "fall-drop",
      title: "Fall drop",
      sponsor_name: "Trevor",
      description: "hi",
      pack_count: 1,
      moments_per_pack: 2,
      admin_wallet: "0x00000000000000aa",
    })
    expect((created as { moment_ids: string[] }).moment_ids.sort()).toEqual(["10", "11"])
  })

  it("a Top Shot username loads and the draft uses the RESOLVED address (2026-10-03)", async () => {
    let created: unknown = null
    let asked = ""
    stub((url, init) => {
      if (url.startsWith("/api/admin/giveaways?candidates=")) {
        asked = decodeURIComponent(url.split("candidates=")[1])
        return json({ ...CANDIDATES, username: "JamesDillonBond" })
      }
      if (init?.method === "POST") {
        created = JSON.parse(String(init.body))
        return json({ id: "d1" })
      }
      return json({ drops: [] })
    })
    render(<AdminGiveawaysClient />)
    await screen.findByText("No drops yet.")
    fireEvent.change(screen.getByPlaceholderText("username or 0x…"), { target: { value: "JamesDillonBond" } })
    fireEvent.click(screen.getByRole("button", { name: /load giftable moments/i }))
    await screen.findByText(/33 the cache called unlocked/)
    expect(asked).toBe("JamesDillonBond") // a username is not lowercased or rejected client-side
    expect(screen.getByText("@JamesDillonBond → 0x00000000000000aa")).toBeTruthy()
    expect((screen.getByPlaceholderText("username or 0x…") as HTMLInputElement).value).toBe("0x00000000000000aa")
    expect(localStorage.getItem("rpc_giveaway_admin_wallet")).toBe("0x00000000000000aa")
    const numbers = screen.getAllByRole("spinbutton")
    fireEvent.change(numbers[0], { target: { value: "1" } })
    fireEvent.change(numbers[1], { target: { value: "1" } })
    fireEvent.click(screen.getByText("Lillard"))
    fireEvent.click(screen.getByRole("button", { name: /create draft \(1\/1\)/i }))
    await screen.findByText("Draft created.")
    expect(created).toMatchObject({ admin_wallet: "0x00000000000000aa" })
  })

  it("a refused draft shows the server's reason", async () => {
    stub((url, init) => {
      if (url.startsWith("/api/admin/giveaways?candidates=")) return json(CANDIDATES)
      if (init?.method === "POST") return json({ error: "giveaway: locked: 10" }, 400)
      return json({ drops: [] })
    })
    render(<AdminGiveawaysClient />)
    await screen.findByText("No drops yet.")
    fireEvent.change(screen.getByPlaceholderText("username or 0x…"), { target: { value: "0x00000000000000aa" } })
    fireEvent.click(screen.getByRole("button", { name: /load giftable moments/i }))
    await screen.findByText(/33 the cache called unlocked/)
    const numbers = screen.getAllByRole("spinbutton")
    fireEvent.change(numbers[0], { target: { value: "1" } })
    fireEvent.change(numbers[1], { target: { value: "1" } })
    fireEvent.click(screen.getByText("Lillard"))
    fireEvent.click(screen.getByRole("button", { name: /create draft \(1\/1\)/i }))
    expect(await screen.findByText("giveaway: locked: 10")).toBeTruthy()
  })

  it("a failed candidate read is an error, never an empty list", async () => {
    stub((url) => (url.startsWith("/api/admin/giveaways?candidates=") ? json({ error: "Flow script HTTP 500" }, 500) : json({ drops: [] })))
    render(<AdminGiveawaysClient />)
    await screen.findByText("No drops yet.")
    fireEvent.click(screen.getByRole("button", { name: /load giftable moments/i }))
    expect(await screen.findByText("Flow script HTTP 500")).toBeTruthy()
    expect(screen.queryByText(/moments confirmed giftable/)).toBeNull()
  })

  it("a malformed candidate payload and an unreadable 200 are both errors", async () => {
    let n = 0
    stub((url) => {
      if (!url.startsWith("/api/admin/giveaways?candidates=")) return json({ drops: [] })
      n += 1
      return n === 1 ? json({ wallet: "x" }) : new Response("<html>", { status: 200 })
    })
    render(<AdminGiveawaysClient />)
    await screen.findByText("No drops yet.")
    fireEvent.click(screen.getByRole("button", { name: /load giftable moments/i }))
    expect(await screen.findByText("The candidate list came back malformed.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /load giftable moments/i }))
    expect(await screen.findByText(/unreadable response/)).toBeTruthy()
  })

  it("a network failure on a call is reported", async () => {
    stub((url) => {
      if (url.startsWith("/api/admin/giveaways?candidates=")) throw new Error("offline")
      return json({ drops: [] })
    })
    render(<AdminGiveawaysClient />)
    await screen.findByText("No drops yet.")
    fireEvent.click(screen.getByRole("button", { name: /load giftable moments/i }))
    expect(await screen.findByText("offline")).toBeTruthy()
  })
})

describe("AdminGiveawaysClient — drops", () => {
  const POOL = [
    { moment_id: "10", pack_no: 1, slot: 1, player_name: "Lillard", serial_number: 7, fmv_usd: 9, delivered_at: "t", last_checked_at: "t", last_check_recipient_holds: true, last_check_admin_holds: false },
    { moment_id: "11", pack_no: 1, slot: 2, player_name: null, serial_number: null, fmv_usd: null, delivered_at: null, last_checked_at: "t", last_check_recipient_holds: false, last_check_admin_holds: false },
    { moment_id: "12", pack_no: 2, slot: 1, player_name: "Simons", serial_number: 3, fmv_usd: 2, delivered_at: null, last_checked_at: null, last_check_recipient_holds: null, last_check_admin_holds: null },
  ]
  const CLAIMS = [{ pack_no: 1, user_id: "u", topshot_username: "alice", recipient_address: "0x01", claimed_at: "t" }]

  it("each status offers only its own actions", async () => {
    stub(() =>
      json({
        drops: [
          DROP({ id: "d1", title: "Draft one" }),
          DROP({ id: "d2", title: "Sealed one", status: "sealed", slug: "sealed-one" }),
          DROP({ id: "d4", title: "Closed one", status: "closed", slug: "closed-one" }),
        ],
      }),
    )
    render(<AdminGiveawaysClient />)
    const draft = (await screen.findByText("Draft one")).parentElement!
    expect(within(draft).getByRole("button", { name: "Seal" })).toBeTruthy()
    expect(within(draft).queryByRole("link")).toBeNull()
    const sealed = screen.getByText("Sealed one").parentElement!
    expect(within(sealed).getByRole("button", { name: /open claims/i })).toBeTruthy()
    expect(within(sealed).getByRole("link").getAttribute("href")).toBe("/giveaways/sealed-one")
    const closed = screen.getByText("Closed one").parentElement!
    expect(within(closed).getByRole("button", { name: /verify deliveries/i })).toBeTruthy()
    expect(within(closed).queryByRole("button", { name: /close claims/i })).toBeNull()
  })

  it("an open drop shows the delivery checklist with who to gift to", async () => {
    stub((url) => (url.endsWith("/d3") ? json({ drop: DROP({ id: "d3", status: "open" }), pool: POOL, claims: CLAIMS }) : json({ drops: [DROP({ id: "d3", status: "open", title: "Open one" })] })))
    render(<AdminGiveawaysClient />)
    expect(await screen.findAllByText("@alice")).toHaveLength(2)
    expect(screen.getByText("delivered")).toBeTruthy()
    expect(screen.getByText(/MISSING/)).toBeTruthy()
    expect(screen.getByText("pack unclaimed")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Hide" }))
    expect(screen.queryByText("@alice")).toBeNull()
  })

  it("actions post the right body; verify reports failed chain reads by name", async () => {
    const posts: string[] = []
    stub((url, init) => {
      if (init?.method === "POST") {
        const action = JSON.parse(init.body as string).action
        posts.push(action)
        if (action === "verify")
          return json({ ok: false, report: { checked: 2, delivered: 1, pending: 1, missing: 0, failed_recipients: ["0x02"], write_error: "boom" } }, 207)
        if (action === "seal") return json({ error: "Locked on chain: 10", code: "locked" }, 409)
        return json({ ok: true })
      }
      if (url.endsWith("/d1")) return json({ error: "nope" }, 500)
      return json({ drops: [DROP({ id: "d1", status: "open", title: "Open one" }), DROP({ id: "d2", title: "Draft one" })] })
    })
    render(<AdminGiveawaysClient />)
    const open = (await screen.findByText("Open one")).parentElement!
    expect(await screen.findByText("Couldn't load the checklist: nope")).toBeTruthy()
    fireEvent.click(within(open).getByRole("button", { name: /verify deliveries/i }))
    expect(await screen.findByText(/Checked 2: 1 delivered, 1 awaiting your gift, 0 missing · chain read FAILED for 0x02/)).toBeTruthy()
    expect(screen.getByText(/write error: boom/)).toBeTruthy()
    // the detail reload that follows the action failed too — it must not replace the report
    expect(screen.getByText("Couldn't load the checklist: nope")).toBeTruthy()
    fireEvent.click(within(open).getByRole("button", { name: /close claims/i }))
    expect(await screen.findByText("close: done")).toBeTruthy()
    const draft = screen.getByText("Draft one").parentElement!
    fireEvent.click(within(draft).getByRole("button", { name: "Seal" }))
    expect(await screen.findByText("Locked on chain: 10")).toBeTruthy()
    fireEvent.click(within(draft).getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(posts).toEqual(["verify", "close", "seal", "delete"]))
  })

  it("a declined confirm sends nothing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false)
    const f = stub(() => json({ drops: [DROP({ id: "d2", title: "Draft one" })] }))
    render(<AdminGiveawaysClient />)
    const draft = (await screen.findByText("Draft one")).parentElement!
    fireEvent.click(within(draft).getByRole("button", { name: "Delete" }))
    fireEvent.click(within(draft).getByRole("button", { name: "Details" }))
    await waitFor(() => expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false))
  })

  it("a failed list read keeps the page and says so", async () => {
    stub(() => json({ error: "db down" }, 503))
    render(<AdminGiveawaysClient />)
    expect(await screen.findByText(/HTTP 503/)).toBeTruthy()
  })
})

describe("AdminGiveawaysClient — sign in with Flow Wallet to build a pool (2026-10-03)", () => {
  const ACROSS = {
    parent: "0x00000000000000bb",
    accounts: [
      { address: "0x00000000000000bb", role: "flow_wallet", onchain_count: 0, cache_count: 0, giftable: 0, excluded: { locked: 0, not_held: 0 } },
      { address: "0x00000000000000aa", role: "linked", name: "Dapper Wallet", dapper: true, onchain_count: 15547, cache_count: 2, giftable: 2, excluded: { locked: 0, not_held: 0 } },
      { address: "0x00000000000000cc", role: "linked", name: "Creator Hub", dapper: false, onchain_count: 12, cache_count: 0, giftable: 0, excluded: { locked: 0, not_held: 0 } },
    ],
    candidates: CANDIDATES.candidates.map((c) => ({ ...c, source_wallet: "0x00000000000000aa" })),
  }

  beforeEach(() => {
    wallet.connect.mockReset()
  })

  it("lists every account honestly, labels where each moment comes from, and drafts with one source per moment", async () => {
    let created: Record<string, unknown> | null = null
    let asked = ""
    stub((url, init) => {
      if (url.includes("accounts_for=")) {
        asked = decodeURIComponent(url.split("accounts_for=")[1])
        return json(ACROSS)
      }
      if (init?.method === "POST") {
        created = JSON.parse(String(init.body))
        return json({ id: "d1" }, 201)
      }
      return json({ drops: [] })
    })
    wallet.connect.mockResolvedValue("0x00000000000000bb")
    render(<AdminGiveawaysClient />)
    await screen.findByText("No drops yet.")
    fireEvent.click(screen.getByRole("button", { name: /connect flow wallet \(loads it and every linked account\)/i }))
    expect(await screen.findByText("Flow Wallet 0x00000000000000bb: 0 Top Shot moments")).toBeTruthy()
    expect(asked).toBe("0x00000000000000bb")
    // the Dapper account is called out by name (read on chain), with its full address
    expect(screen.getByText("Dapper wallet 0x00000000000000aa: 15,547 Top Shot moments on chain · 2 unlocked and giftable now")).toBeTruthy()
    // held on chain but not in RPC's cache: never shown as empty
    expect(screen.getByText(/Linked account “Creator Hub” 0x00000000000000cc: 12 Top Shot moments on chain, not indexed by RPC yet/)).toBeTruthy()
    expect(screen.getAllByText("Dapper wallet 0x00000000000000aa").length).toBe(2) // the "From" column, one per candidate
    const numbers = screen.getAllByRole("spinbutton")
    fireEvent.change(numbers[0], { target: { value: "1" } })
    fireEvent.change(numbers[1], { target: { value: "2" } })
    fireEvent.click(screen.getByText("Lillard"))
    fireEvent.click(screen.getAllByRole("checkbox")[1]) // the unnamed moment's row
    fireEvent.click(screen.getByRole("button", { name: /create draft \(2\/2\)/i }))
    await screen.findByText("Draft created.")
    expect(created).toMatchObject({ admin_wallet: "0x00000000000000bb", source_wallets: ["0x00000000000000aa", "0x00000000000000aa"] })
    expect((created as unknown as { moment_ids: string[] }).moment_ids.sort()).toEqual(["10", "11"])
  })

  it("a refused wallet connection or a failed lookup is shown, never an empty pool", async () => {
    stub((url) => (url.includes("accounts_for=") ? json({ error: "Flow script HTTP 503" }, 502) : json({ drops: [] })))
    wallet.connect.mockRejectedValueOnce({ code: 5000, message: "User rejected" })
    render(<AdminGiveawaysClient />)
    await screen.findByText("No drops yet.")
    const connect = screen.getByRole("button", { name: /connect flow wallet \(loads/i })
    fireEvent.click(connect)
    expect(await screen.findByText("Wallet: User rejected (code 5000)")).toBeTruthy()
    wallet.connect.mockResolvedValueOnce("0x00000000000000bb")
    fireEvent.click(connect)
    expect(await screen.findByText("Flow script HTTP 502".replace("502", "503"))).toBeTruthy()
    expect(screen.queryByText(/Top Shot moments/)).toBeNull()
  })

  it("a malformed account list is an error", async () => {
    stub((url) => (url.includes("accounts_for=") ? json({ parent: "x" }) : json({ drops: [] })))
    wallet.connect.mockResolvedValueOnce("0x00000000000000bb")
    render(<AdminGiveawaysClient />)
    await screen.findByText("No drops yet.")
    fireEvent.click(screen.getByRole("button", { name: /connect flow wallet \(loads/i }))
    expect(await screen.findByText("The account list came back malformed.")).toBeTruthy()
  })
})

describe("AdminGiveawaysClient — deliver all (one signature per batch)", () => {
  const PLAN = {
    parent: "0x00000000000000bb",
    batches: [
      { source: "0x00000000000000aa", kind: "linked", providerControllerID: "70", momentIDs: ["1", "2"], recipients: ["0x01", "0x02"] },
      { source: "0x00000000000000aa", kind: "linked", providerControllerID: "70", momentIDs: ["3"], recipients: ["0x03"] },
    ],
    skipped: [
      { moment_id: "9", reason: "locked" },
      { moment_id: "8", reason: "not_held" },
    ],
  }
  const REPORT = { checked: 3, delivered: 3, pending: 0, missing: 0, failed_recipients: [], written: 3, write_error: null }

  beforeEach(() => {
    wallet.connect.mockReset()
    wallet.disconnect.mockReset()
    wallet.send.mockReset()
  })

  function server(planResponse: Response | (() => Response), verify: Response = json({ ok: true, report: REPORT })) {
    const posts: unknown[] = []
    stub((url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string)
        posts.push(body)
        if (body.action === "deliver_plan") return typeof planResponse === "function" ? planResponse() : planResponse
        if (body.action === "verify") return verify
      }
      if (url.endsWith("/d3")) return json({ drop: DROP({ id: "d3", status: "open" }), pool: [], claims: [] })
      return json({ drops: [DROP({ id: "d3", status: "open", title: "Open one" })] })
    })
    return posts
  }

  async function connected() {
    wallet.connect.mockResolvedValue("0x00000000000000bb")
    render(<AdminGiveawaysClient />)
    fireEvent.click(await screen.findByRole("button", { name: "Connect Flow Wallet" }))
    return screen.findByText(/Flow Wallet 0x00000000000000bb/)
  }

  it("is offered only on open or closed drops", async () => {
    stub(() => json({ drops: [DROP({ id: "d1", title: "Draft one" }), DROP({ id: "d2", status: "sealed", title: "Sealed one" })] }))
    render(<AdminGiveawaysClient />)
    await screen.findByText("Draft one")
    expect(screen.queryByRole("button", { name: "Connect Flow Wallet" })).toBeNull()
  })

  it("plans with the connected wallet, signs each batch in order, then verifies on chain", async () => {
    const posts = server(json({ ok: true, plan: PLAN }))
    await connected()
    wallet.send.mockResolvedValueOnce({ txId: "tx1" }).mockResolvedValueOnce({ txId: "tx2" })
    fireEvent.click(screen.getByRole("button", { name: /deliver claimed moments/i }))
    expect(await screen.findByText(/Verified on chain: 3 delivered, 0 still with you, 0 missing/)).toBeTruthy()
    expect(posts[0]).toEqual({ action: "deliver_plan", parent: "0x00000000000000bb" })
    expect(wallet.send.mock.calls.map((c) => (c[0] as { momentIDs: string[] }).momentIDs)).toEqual([["1", "2"], ["3"]])
    expect(wallet.send.mock.calls[0][0]).toMatchObject({ source: "0x00000000000000aa", kind: "linked", providerControllerID: "70" })
    expect(screen.getByText(/Batch 1: sealed · 2 moment\(s\) · tx tx1/)).toBeTruthy()
    expect(screen.getByText(/Skipped 9: locked on chain/)).toBeTruthy()
    expect(screen.getByText(/Skipped 8: no longer in your account/)).toBeTruthy()
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Send 3 moment(s) from 0x00000000000000aa in 2 transaction(s)"))
  })

  it("a declined or failed batch stops the run, and Verify still reports what landed", async () => {
    server(
      json({ ok: true, plan: PLAN }),
      json({ ok: false, report: { ...REPORT, delivered: 0, pending: 3, failed_recipients: ["0x03"] } }, 207),
    )
    await connected()
    wallet.send.mockRejectedValueOnce(new Error("User rejected signature"))
    fireEvent.click(screen.getByRole("button", { name: /deliver claimed moments/i }))
    expect(await screen.findByText(/Batch 1 NOT sent: User rejected signature/)).toBeTruthy()
    expect(wallet.send).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/chain read FAILED for 0x03/)).toBeTruthy()
  })

  it("a SUBMITTED batch whose seal couldn't be read is reported UNCONFIRMED, never 'NOT sent'", async () => {
    server(json({ ok: true, plan: PLAN }), json({ ok: true, report: { ...REPORT, delivered: 0, pending: 3 } }))
    await connected()
    wallet.send.mockRejectedValueOnce(new wallet.SealUnconfirmedError("tx9", "Load failed"))
    fireEvent.click(screen.getByRole("button", { name: /deliver claimed moments/i }))
    expect(await screen.findByText(/Batch 1 UNCONFIRMED: Transaction tx9 was submitted/)).toBeTruthy()
    expect(screen.queryByText(/NOT sent/)).toBeNull()
    expect(wallet.send).toHaveBeenCalledTimes(1)
  })

  it("cancelling the confirm sends nothing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false)
    const posts = server(json({ ok: true, plan: PLAN }))
    await connected()
    fireEvent.click(screen.getByRole("button", { name: /deliver claimed moments/i }))
    expect(await screen.findByText("Cancelled; nothing was sent.")).toBeTruthy()
    expect(wallet.send).not.toHaveBeenCalled()
    expect(posts.some((p) => (p as { action: string }).action === "verify")).toBe(false)
  })

  it("a refused or malformed plan is shown, and nothing is signed", async () => {
    let n = 0
    server(() => (++n === 1 ? json({ error: "Cadence: Cannot withdraw: Moment is locked" }, 409) : json({ ok: true, plan: { batches: "x" } })))
    await connected()
    fireEvent.click(screen.getByRole("button", { name: /deliver claimed moments/i }))
    expect(await screen.findByText("Cadence: Cannot withdraw: Moment is locked")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /deliver claimed moments/i }))
    expect(await screen.findByText("The delivery plan came back malformed.")).toBeTruthy()
    expect(wallet.send).not.toHaveBeenCalled()
  })

  it("a failed verify after sending is reported, not swallowed", async () => {
    server(json({ ok: true, plan: { ...PLAN, batches: [PLAN.batches[1]], skipped: [] } }), json({ error: "db down" }, 500))
    await connected()
    wallet.send.mockResolvedValueOnce({ txId: "tx9" })
    fireEvent.click(screen.getByRole("button", { name: /deliver claimed moments/i }))
    expect(await screen.findByText("Verify: db down")).toBeTruthy()
  })

  it("wallet connect errors are shown; disconnect returns to the connect button", async () => {
    server(json({ ok: true, plan: PLAN }))
    wallet.connect.mockRejectedValueOnce(new Error("Popup closed"))
    render(<AdminGiveawaysClient />)
    fireEvent.click(await screen.findByRole("button", { name: "Connect Flow Wallet" }))
    expect(await screen.findByText("Wallet: Popup closed")).toBeTruthy()
    wallet.connect.mockResolvedValueOnce("0x00000000000000bb")
    fireEvent.click(screen.getByRole("button", { name: "Connect Flow Wallet" }))
    await screen.findByText(/Flow Wallet 0x00000000000000bb/)
    wallet.disconnect.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }))
    expect(await screen.findByRole("button", { name: "Connect Flow Wallet" })).toBeTruthy()
  })
})
