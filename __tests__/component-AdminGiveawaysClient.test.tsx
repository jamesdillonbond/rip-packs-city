// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react"
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
    fireEvent.change(screen.getByPlaceholderText("0x…"), { target: { value: "0x00000000000000AA" } })
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

  it("a refused draft shows the server's reason", async () => {
    stub((url, init) => {
      if (url.startsWith("/api/admin/giveaways?candidates=")) return json(CANDIDATES)
      if (init?.method === "POST") return json({ error: "giveaway: locked: 10" }, 400)
      return json({ drops: [] })
    })
    render(<AdminGiveawaysClient />)
    await screen.findByText("No drops yet.")
    fireEvent.change(screen.getByPlaceholderText("0x…"), { target: { value: "0x00000000000000aa" } })
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
