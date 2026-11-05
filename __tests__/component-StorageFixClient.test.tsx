// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"

const wallet = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() }))
vi.mock("@/lib/storage-fix/wallet", () => ({
  SealUnconfirmedError: class SealUnconfirmedError extends Error {
    constructor(readonly txId: string) {
      super(`Transaction ${txId} was submitted, but its result could not be read`)
    }
  },
  connectFlowWallet: () => wallet.connect(),
  disconnectFlowWallet: () => wallet.disconnect(),
  sendStorageFix: (...a: unknown[]) => wallet.send(...a),
}))
vi.mock("@/lib/admin-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-token")>()),
  toAdminSession: async (t: string) => t,
  upgradeStoredAdminToken: async () => {},
}))

import StorageFixClient from "@/app/admin/storage-fix/StorageFixClient"
import { ADMIN_TOKEN_KEY } from "@/lib/admin/use-admin-resource"
import type { StorageCheck } from "@/lib/storage-fix/check"

// The admin storage-fix console (2026-11-05). What the operator must be able to trust:
// nothing is signed unless a FRESH check says the account is still stuck AND the fix
// simulated cleanly as their own wallet; a refusal or a failed read is said, never a
// silent success; an account Dapper already refilled is called out as such.

const ADDR = "0x9124f9b74b02e86e"
const ME = "0x3d0b274c80263484"

function check(o: Partial<StorageCheck> = {}): StorageCheck {
  return {
    address: ADDR,
    checkedAt: { height: 170_111_846, at: "2026-11-05T10:18:31Z" },
    state: { usedBytes: 101_541, capacityBytes: 100_000, balanceFlow: 0.001, isDapperWallet: true, hasFlowReceiver: false, megabytesPerFlow: 100 },
    plan: { headroomBytes: -1_541, stuck: true, kind: "dapper_refill", amount: "0.02000000", addsBytes: 2_000_000, reason: "Dapper wallet: refill." },
    history: { status: "none", searchedBackTo: { height: 166_611_859, at: "2026-10-04T00:15:36Z" } },
    contracts: { dapperStorageRent: "0xa08e88e23f332538", privateForwarder: "0x18eb4ee6b3c026d2" },
    ...o,
  }
}
const SIM_OK = { ok: true, kind: "dapper_refill", signer: ME, amount: "0.02000000", capacityBefore: 100_000, capacityAfter: 2_100_000 } as const

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
function stub(handler: (url: string) => Response) {
  const f = vi.fn(async (url: string) => handler(url))
  vi.stubGlobal("fetch", f)
  return f
}

beforeEach(() => {
  localStorage.setItem(ADMIN_TOKEN_KEY, "tok")
  wallet.disconnect.mockResolvedValue(undefined)
  wallet.connect.mockResolvedValue(ME)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  localStorage.clear()
})

async function checkAddress() {
  fireEvent.change(screen.getByLabelText("Flow address"), { target: { value: ADDR } })
  fireEvent.click(screen.getByRole("button", { name: "Check" }))
}

describe("StorageFixClient", () => {
  it("asks for the admin token first and calls nothing", () => {
    localStorage.clear()
    const f = stub(() => json({}))
    render(<StorageFixClient />)
    expect(screen.getByText("Admin token required.")).toBeTruthy()
    expect(f).not.toHaveBeenCalled()
  })

  it("shows a stuck Dapper wallet, proposes the refill, and keeps Send disabled until a wallet is connected", async () => {
    const f = stub(() => json({ check: check() }))
    render(<StorageFixClient />)
    await checkAddress()
    expect(await screen.findByText(/^Stuck: using 101,541 bytes/)).toBeTruthy()
    expect(screen.getByText(/Dapper wallet \(needs the Dapper refill\)/)).toBeTruthy()
    expect(String(f.mock.calls[0][0])).toBe(`/api/admin/storage-fix?address=${encodeURIComponent(ADDR)}`)
    const send = screen.getByRole("button", { name: /Send 0\.02 FLOW Dapper refill/ }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
  })

  it("re-checks and simulates as the connected wallet, then signs exactly what the simulation ran", async () => {
    const f = stub((url) => json({ check: url.includes("simulate_from") ? check({ simulation: SIM_OK }) : check() }))
    wallet.send.mockResolvedValue({ txId: "abc123" })
    render(<StorageFixClient />)
    await checkAddress()
    await screen.findByText(/^Stuck:/)
    fireEvent.click(screen.getByRole("button", { name: "Connect Flow Wallet" }))
    expect(await screen.findByText(`Signing as ${ME}`)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Send 0\.02 FLOW Dapper refill/ }))
    await screen.findByText("abc123")
    expect(String(f.mock.calls[1][0])).toContain(`simulate_from=${encodeURIComponent(ME)}&amount=0.02000000`)
    expect(wallet.send).toHaveBeenCalledWith({ kind: "dapper_refill", receiver: ADDR, amount: "0.02000000" }, expect.anything())
  })

  it("a simulation refusal signs NOTHING and says why", async () => {
    stub((url) =>
      json({ check: url.includes("simulate_from") ? check({ simulation: { ok: false, kind: "dapper_refill", signer: ME, amount: "0.02000000", reason: "Could not borrow reference to private forwarder" } }) : check() }),
    )
    render(<StorageFixClient />)
    await checkAddress()
    await screen.findByText(/^Stuck:/)
    fireEvent.click(screen.getByRole("button", { name: "Connect Flow Wallet" }))
    await screen.findByText(`Signing as ${ME}`)
    fireEvent.click(screen.getByRole("button", { name: /Send 0\.02 FLOW/ }))
    expect(await screen.findByText(/The simulation refused, so nothing was signed: Could not borrow reference to private forwarder/)).toBeTruthy()
    expect(wallet.send).not.toHaveBeenCalled()
  })

  it("an account refilled meanwhile is NOT sent to: the fresh check stops it", async () => {
    const fixed = check({
      state: { usedBytes: 103_997, capacityBytes: 6_100_000, balanceFlow: 0.061, isDapperWallet: true, hasFlowReceiver: false, megabytesPerFlow: 100 },
      plan: { headroomBytes: 5_996_003, stuck: false, kind: "dapper_refill", amount: "0.01000000", addsBytes: 1_000_000, reason: "Dapper wallet." },
      simulation: SIM_OK,
    })
    let n = 0
    stub(() => json({ check: n++ === 0 ? check() : fixed }))
    render(<StorageFixClient />)
    await checkAddress()
    await screen.findByText(/^Stuck:/)
    fireEvent.click(screen.getByRole("button", { name: "Connect Flow Wallet" }))
    await screen.findByText(`Signing as ${ME}`)
    fireEvent.click(screen.getByRole("button", { name: /Send 0\.02 FLOW/ }))
    expect(await screen.findByText(/it is no longer stuck, so nothing was sent/)).toBeTruthy()
    expect(wallet.send).not.toHaveBeenCalled()
  })

  it("says when Dapper already fixed it, with the transaction", async () => {
    stub(() =>
      json({
        check: check({
          state: { usedBytes: 103_997, capacityBytes: 6_100_000, balanceFlow: 0.061, isDapperWallet: true, hasFlowReceiver: false, megabytesPerFlow: 100 },
          plan: { headroomBytes: 5_996_003, stuck: false, kind: "dapper_refill", amount: "0.01000000", addsBytes: 1_000_000, reason: "Dapper wallet." },
          history: {
            status: "found",
            change: {
              height: 169_925_218,
              at: "2026-11-03T16:50:05.027Z",
              capacityBefore: 100_000,
              capacityAfter: 6_100_000,
              txId: "6d23cc22",
              payer: "0x18eb4ee6b3c026d2",
              authorizers: ["0x18eb4ee6b3c026d2"],
              amountFlow: 0.06,
              viaDapperForwarder: true,
              byDapper: true,
            },
            searchedBackTo: { height: 166_611_859, at: "2026-10-04T00:15:36Z" },
          },
        }),
      }),
    )
    render(<StorageFixClient />)
    await checkAddress()
    expect(await screen.findByText(/Not stuck: .* Dapper already fixed it\./)).toBeTruthy()
    expect(screen.getByText(/Last topped up Nov 3, 2026, 8:50 AM PT: 0\.06 FLOW from Dapper itself/)).toBeTruthy()
    expect((screen.getByRole("link", { name: "View transaction" }) as HTMLAnchorElement).href).toBe("https://www.flowscan.io/tx/6d23cc22")
  })

  it("a failed check is an error on screen, never an empty result", async () => {
    stub(() => json({ error: "Flow REST /blocks returned HTTP 503.", code: "flow_http" }, 502))
    render(<StorageFixClient />)
    await checkAddress()
    expect(await screen.findByText("Flow REST /blocks returned HTTP 503.")).toBeTruthy()
    expect(screen.queryByText(/^Stuck:|^Not stuck:|^Nearly stuck:/)).toBeNull()
  })

  it("a seal it could not read says so and links the transaction — never 'failed'", async () => {
    const { SealUnconfirmedError } = await import("@/lib/storage-fix/wallet")
    stub((url) => json({ check: url.includes("simulate_from") ? check({ simulation: SIM_OK }) : check() }))
    wallet.send.mockRejectedValue(new SealUnconfirmedError("tx9"))
    render(<StorageFixClient />)
    await checkAddress()
    await screen.findByText(/^Stuck:/)
    fireEvent.click(screen.getByRole("button", { name: "Connect Flow Wallet" }))
    await screen.findByText(`Signing as ${ME}`)
    fireEvent.click(screen.getByRole("button", { name: /Send 0\.02 FLOW/ }))
    await waitFor(() => expect(screen.getByRole("link", { name: "Check it on Flowscan" })).toBeTruthy())
  })
})
