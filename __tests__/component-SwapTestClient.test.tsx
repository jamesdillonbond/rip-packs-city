// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"

const wallet = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), coSign: vi.fn() }))
vi.mock("@/lib/swap-test/swap-wallet", () => ({
  connectFlowWallet: () => wallet.connect(),
  disconnectFlowWallet: () => wallet.disconnect(),
  sendSwap: (...a: unknown[]) => wallet.send(...a),
  coSign: (...a: unknown[]) => wallet.coSign(...a),
}))
const nav = vi.hoisted(() => ({ relay: null as string | null }))
vi.mock("next/navigation", () => ({ useSearchParams: () => ({ get: (k: string) => (k === "relay" ? nav.relay : null) }) }))

import SwapTestClient from "@/app/admin/swap-test/SwapTestClient"
import { ADMIN_TOKEN_KEY } from "@/lib/admin/use-admin-resource"
import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"

// The two-signer swap console. What an operator must be able to trust: nothing can be
// signed before the mainnet simulation passed; the co-signer sees what the RELAYED
// transaction does (decoded from its own arguments) and is told not to sign anything
// else; a failed call is an error, never a silent success.

const A = "0x3d0b274c80263484"
const B = "0xd96dc67ae64ee202"
const PLAN = {
  a: { signer: A, source: "0xbd94cade097e50ac", ids: ["27289790"], kind: "linked", ctl: "87" },
  b: { signer: B, source: B, ids: [], kind: "own", ctl: "0" },
}
const SIGNABLE = {
  cadence: SWAP_CADENCE,
  args: [
    { type: "Address", value: "0xbd94cade097e50ac" },
    { type: "UInt64", value: "87" },
    { type: "Array", value: [{ type: "UInt64", value: "27289790" }] },
    { type: "Address", value: B },
    { type: "UInt64", value: "0" },
    { type: "Array", value: [] },
  ],
}
const RELAY = { id: "r1", cosigner: B, signable: SIGNABLE, signature: null, key_id: null, created_at: "2026-10-03T12:00:00Z", signed_at: null }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
function stub(handler: (url: string, init?: RequestInit) => Response) {
  const f = vi.fn(async (url: string, init?: RequestInit) => handler(url, init))
  vi.stubGlobal("fetch", f)
  return f
}
const body = (init?: RequestInit) => JSON.parse(String(init?.body ?? "{}"))

beforeEach(() => {
  localStorage.setItem(ADMIN_TOKEN_KEY, "tok")
  nav.relay = null
  wallet.disconnect.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  localStorage.clear()
})

describe("SwapTestClient — token gate", () => {
  it("asks for the token first", () => {
    localStorage.clear()
    render(<SwapTestClient />)
    expect(screen.getByText("Admin token required.")).toBeTruthy()
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: "tok" } })
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(screen.getByRole("button", { name: /simulate on mainnet/i })).toBeTruthy()
  })
})

describe("SwapTestClient — initiator", () => {
  it("prefills the first run and cannot sign before a simulation passed", () => {
    render(<SwapTestClient />)
    expect((screen.getAllByDisplayValue(A)[0] as HTMLInputElement).value).toBe(A)
    expect(screen.getByDisplayValue("27289790")).toBeTruthy()
    expect((screen.getByRole("button", { name: /sign and send/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("posts both sides to the planner and shows a failed simulation as an error", async () => {
    const f = stub((_u, init) => (body(init).action === "plan" ? json({ error: "Side A: locked on chain", code: "locked" }, 409) : json({})))
    render(<SwapTestClient />)
    // side B starts empty: 0xd96d… can't sign alone, so Trevor adds a second Flow Wallet account
    const inputs = document.querySelectorAll("main input")
    expect((inputs[3] as HTMLInputElement).value).toBe("")
    fireEvent.change(inputs[3], { target: { value: B } })
    fireEvent.change(inputs[4], { target: { value: B } })
    fireEvent.click(screen.getByRole("button", { name: /simulate on mainnet/i }))
    expect(await screen.findByText(/locked on chain/)).toBeTruthy()
    const sent = body(f.mock.calls[0][1])
    expect(sent).toEqual({
      action: "plan",
      a: { signer: A, source: "0xbd94cade097e50ac", ids: ["27289790"] },
      b: { signer: B, source: B, ids: [] },
    })
    expect((screen.getByRole("button", { name: /sign and send/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("an unreadable response is an error, not a plan", async () => {
    stub(() => new Response("<html>", { status: 200 }))
    render(<SwapTestClient />)
    fireEvent.click(screen.getByRole("button", { name: /simulate on mainnet/i }))
    expect(await screen.findByText(/unreadable response/)).toBeTruthy()
  })

  let verified: unknown[] = []
  let verifyReplies: Response[] = []
  beforeEach(() => {
    verified = []
    verifyReplies = []
  })

  async function runToSeal() {
    render(<SwapTestClient />)
    fireEvent.click(screen.getByRole("button", { name: /simulate on mainnet/i }))
    await screen.findByText(/every moment lands/)
    fireEvent.click(screen.getByRole("button", { name: /connect flow wallet \(side a\)/i }))
    await screen.findByText(A)
    fireEvent.click(screen.getByRole("button", { name: /sign and send/i }))
    await screen.findByText(/Sealed on chain/)
  }

  it("simulates, connects wallet A, relays B's request, and reports the sealed transaction", async () => {
    const f = stub((_u, init) => {
      const b = body(init)
      if (b.action === "plan") return json({ plan: PLAN })
      if (b.action === "relay_post") return json({ id: "r1" })
      if (b.action === "verify") {
        verified.push(b.plan)
        return verifyReplies.length ? verifyReplies.shift()! : json({ landed: [{ id: "27289790", to: B, held: true }] })
      }
      return json({ relay: { ...RELAY, signature: "ab".repeat(64), key_id: 0 } })
    })
    wallet.connect.mockResolvedValue(A)
    wallet.send.mockImplementation(async (_plan: unknown, io: { post: (c: string, s: unknown) => Promise<string>; onRelay: (id: string) => void; waitForSignature: (id: string) => Promise<unknown> }) => {
      const id = await io.post(B, SIGNABLE)
      io.onRelay(id)
      await io.waitForSignature(id)
      return { txId: "tx9" }
    })
    render(<SwapTestClient />)
    fireEvent.click(screen.getByRole("button", { name: /simulate on mainnet/i }))
    expect(await screen.findByText(/every moment lands/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /connect flow wallet \(side a\)/i }))
    expect(await screen.findByText(A)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /sign and send/i }))
    expect(await screen.findByText(/Sealed on chain/)).toBeTruthy()
    expect(screen.getByRole("link", { name: "tx9" }).getAttribute("href")).toBe("https://www.flowscan.io/tx/tx9")
    expect(screen.getByText(/swap-test\?relay=r1/)).toBeTruthy()
    expect(wallet.send.mock.calls[0][0]).toEqual(PLAN)
    expect(f.mock.calls.some((c) => String(c[0]).includes("?relay=r1"))).toBe(true)
    // the seal is followed by a chain read of where each moment is now
    expect(await screen.findByText(/27289790 is now in 0xd96dc67ae64ee202/)).toBeTruthy()
    expect(verified).toEqual([PLAN])
  })

  function sealingStub() {
    stub((_u, init) => {
      const b = body(init)
      if (b.action === "plan") return json({ plan: PLAN })
      if (b.action === "relay_post") return json({ id: "r1" })
      if (b.action === "verify") {
        verified.push(b.plan)
        return verifyReplies.length ? verifyReplies.shift()! : json({ landed: [{ id: "27289790", to: B, held: true }] })
      }
      return json({ relay: { ...RELAY, signature: "ab".repeat(64), key_id: 0 } })
    })
    wallet.connect.mockResolvedValue(A)
    wallet.send.mockResolvedValue({ txId: "tx9" })
  }

  it("a chain read that fails after the seal says it couldn't confirm, and Verify again retries", async () => {
    sealingStub()
    verifyReplies = [json({ error: "Couldn't read 0xd96d on chain" }, 502)]
    await runToSeal()
    expect(await screen.findByText(/Couldn't confirm on chain/)).toBeTruthy()
    expect(screen.queryByText(/is NOT in/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /verify again/i }))
    expect(await screen.findByText(/27289790 is now in/)).toBeTruthy()
  })

  it("names a moment that did not land", async () => {
    sealingStub()
    verifyReplies = [json({ landed: [{ id: "27289790", to: B, held: false }] })]
    await runToSeal()
    expect(await screen.findByText(/27289790 is NOT in 0xd96dc67ae64ee202/)).toBeTruthy()
  })

  it("sets up the swap back: same sides, each giving what it received", async () => {
    sealingStub()
    await runToSeal()
    await screen.findByText(/27289790 is now in/)
    fireEvent.click(screen.getByRole("button", { name: /set up the swap back/i }))
    const inputs = [...document.querySelectorAll("main input")].map((i) => (i as HTMLInputElement).value)
    expect(inputs).toEqual([A, "0xbd94cade097e50ac", "", B, B, "27289790"])
    expect(screen.getByText(/Swap-back filled in/)).toBeTruthy()
    expect((screen.getByRole("button", { name: /sign and send/i }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole("link", { name: "tx9" })).toBeNull()
  })

  it("warns when the connected wallet is not side A's signer, and shows a wallet failure", async () => {
    stub(() => json({ plan: PLAN }))
    wallet.connect.mockResolvedValue(B)
    wallet.send.mockRejectedValue({ code: 4001, message: "User rejected" })
    render(<SwapTestClient />)
    fireEvent.click(screen.getByRole("button", { name: /simulate on mainnet/i }))
    await screen.findByText(/every moment lands/)
    fireEvent.click(screen.getByRole("button", { name: /connect flow wallet \(side a\)/i }))
    expect(await screen.findByText(/not side A's signer/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /sign and send/i }))
    expect(await screen.findByText(/User rejected/)).toBeTruthy()
  })

  it("a relay that can't store B's request fails the send", async () => {
    stub((_u, init) => (body(init).action === "plan" ? json({ plan: PLAN }) : json({ error: "relay down" }, 500)))
    wallet.connect.mockResolvedValue(A)
    wallet.send.mockImplementation(async (_p: unknown, io: { post: (c: string, s: unknown) => Promise<string> }) => {
      await io.post(B, SIGNABLE)
      return { txId: "never" }
    })
    render(<SwapTestClient />)
    fireEvent.click(screen.getByRole("button", { name: /simulate on mainnet/i }))
    await screen.findByText(/every moment lands/)
    fireEvent.click(screen.getByRole("button", { name: /connect flow wallet \(side a\)/i }))
    await screen.findByText(A)
    fireEvent.click(screen.getByRole("button", { name: /sign and send/i }))
    expect(await screen.findByText(/relay down/)).toBeTruthy()
    expect(screen.queryByText(/Sealed on chain/)).toBeNull()
  })

  it("a wallet that fails to connect shows why; editing a field drops the old plan", async () => {
    stub(() => json({ plan: PLAN }))
    wallet.connect.mockRejectedValue(new Error("Popup closed"))
    render(<SwapTestClient />)
    fireEvent.click(screen.getByRole("button", { name: /connect flow wallet \(side a\)/i }))
    expect(await screen.findByText(/Popup closed/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /simulate on mainnet/i }))
    await screen.findByText(/every moment lands/)
    fireEvent.change(screen.getByDisplayValue("27289790"), { target: { value: "1" } })
    expect((screen.getByRole("button", { name: /sign and send/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("SwapTestClient — co-signer", () => {
  it("shows what the relayed transaction does, then signs and posts B's signature", async () => {
    nav.relay = "r1"
    const f = stub((u, init) => (init?.method === "POST" ? json({ ok: true }) : json({ relay: RELAY })))
    wallet.connect.mockResolvedValue(B)
    wallet.coSign.mockResolvedValue({ signature: "ab".repeat(64), keyId: 2 })
    render(<SwapTestClient />)
    expect(await screen.findByText(/Side A gives 27289790 from 0xbd94cade097e50ac → to 0xd96dc67ae64ee202/)).toBeTruthy()
    expect(screen.getByText(/Side B gives nothing/)).toBeTruthy()
    expect((screen.getByRole("button", { name: /sign as side b/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: /connect flow wallet \(side b\)/i }))
    await screen.findByText(B)
    fireEvent.click(screen.getByRole("button", { name: /sign as side b/i }))
    expect(await screen.findByText(/Signed\. Go back/)).toBeTruthy()
    expect(wallet.coSign).toHaveBeenCalledWith(SIGNABLE, B)
    const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
    expect(body(post[1])).toEqual({ action: "relay_sign", id: "r1", signature: "ab".repeat(64), key_id: 2 })
  })

  it("tells the co-signer not to sign anything that isn't the swap", async () => {
    nav.relay = "r1"
    stub(() => json({ relay: { ...RELAY, signable: { ...SIGNABLE, cadence: "transaction {}" } } }))
    render(<SwapTestClient />)
    expect(await screen.findByText(/not the swap-test transaction/)).toBeTruthy()
    expect((screen.getByRole("button", { name: /sign as side b/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("an expired request is an error, not an empty page", async () => {
    nav.relay = "r1"
    stub(() => json({ error: "This swap request expired; start a new one." }, 410))
    render(<SwapTestClient />)
    expect(await screen.findByText(/expired/)).toBeTruthy()
  })

  it("a refused signature post is shown, not reported as signed", async () => {
    nav.relay = "r1"
    stub((_u, init) => (init?.method === "POST" ? json({ error: "This swap request was already signed." }, 409) : json({ relay: RELAY })))
    wallet.connect.mockResolvedValue(B)
    wallet.coSign.mockResolvedValue({ signature: "ab".repeat(64), keyId: 2 })
    render(<SwapTestClient />)
    await screen.findByText(/Side B gives nothing/)
    fireEvent.click(screen.getByRole("button", { name: /connect flow wallet \(side b\)/i }))
    await screen.findByText(B)
    fireEvent.click(screen.getByRole("button", { name: /sign as side b/i }))
    expect(await screen.findByText(/already signed/)).toBeTruthy()
    expect(screen.queryByText(/Signed\. Go back/)).toBeNull()
  })

  it("a co-signer wallet that fails to connect shows why", async () => {
    nav.relay = "r1"
    stub(() => json({ relay: RELAY }))
    wallet.connect.mockRejectedValue(new Error("No wallet"))
    render(<SwapTestClient />)
    await screen.findByText(/Side B gives nothing/)
    fireEvent.click(screen.getByRole("button", { name: /connect flow wallet \(side b\)/i }))
    await waitFor(() => expect(screen.getByText(/No wallet/)).toBeTruthy())
  })

  it("an already-signed request says so instead of offering to sign again", async () => {
    nav.relay = "r1"
    stub(() => json({ relay: { ...RELAY, signature: "ab".repeat(64), key_id: 0 } }))
    render(<SwapTestClient />)
    expect(await screen.findByText(/Signed\. Go back/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /sign as side b/i })).toBeNull()
  })
})
