import { describe, it, expect, vi, beforeEach } from "vitest"

// The one wallet-connect module (admin only). What matters: discovery is set at
// CONNECT time (never on import), the transaction sent is DELIVER_BATCH_CADENCE with
// the plan's arguments in order, and a batch is only reported sent once it SEALS
// without an error.

const fcl = vi.hoisted(() => {
  const put = vi.fn()
  const self = {
    put,
    config: vi.fn(() => ({ put })),
    authenticate: vi.fn(),
    unauthenticate: vi.fn(),
    mutate: vi.fn(),
    onceSealed: vi.fn(),
    tx: vi.fn(() => ({ onceSealed: () => self.onceSealed() })),
    arg: vi.fn((value: unknown, type: unknown) => ({ value, type })),
    t: { Address: "Address", UInt64: "UInt64", Array: (x: string) => `Array(${x})` },
    currentUser: { snapshot: vi.fn(async (): Promise<unknown> => ({})) },
  }
  return self
})
vi.mock("@onflow/fcl", () => fcl)
vi.mock("@/lib/chains/flow/flow", () => ({ initFcl: vi.fn() }))

import { SealUnconfirmedError, channelOf, slowWalletHint, connectAdminWallet, disconnectAdminWallet, prepareWalletConnect, sendDeliveryBatch, startNetworkTrace } from "@/lib/giveaways/admin-wallet"
import { DELIVER_BATCH_CADENCE, DELIVER_GAS_LIMIT, DELIVER_OWN_BATCH_CADENCE } from "@/lib/giveaways/deliver-cadence"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("giveaways/admin-wallet", () => {
  it("importing the module configures no wallet discovery", () => {
    expect(fcl.put).not.toHaveBeenCalledWith("discovery.wallet", expect.anything())
  })

  it("WalletConnect (the Flow Wallet mobile app) is configured in the browser when a project id exists", () => {
    // this suite runs in node: no window, so nothing is configured
    expect(prepareWalletConnect("abc")).toBe(false)
    expect(fcl.put).not.toHaveBeenCalled()
    vi.stubGlobal("window", {})
    try {
      expect(prepareWalletConnect("")).toBe(false)
      expect(fcl.put).not.toHaveBeenCalled()
      expect(prepareWalletConnect("abc")).toBe(true)
      expect(fcl.put).toHaveBeenCalledWith("walletconnect.projectId", "abc")
      // the WC loader queries discovery at once; unset, FCL throws an INVARIANT at page load
      expect(fcl.put).toHaveBeenCalledWith("discovery.authn.endpoint", "https://fcl-discovery.onflow.org/api/authn")
      const keys = fcl.put.mock.calls.map((c: unknown[]) => c[0])
      expect(keys.indexOf("discovery.authn.endpoint")).toBeLessThan(keys.indexOf("walletconnect.projectId"))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("connect sets discovery, authenticates, and returns the lowercased address", async () => {
    fcl.authenticate.mockResolvedValueOnce({ addr: "0xD96DC67AE64EE202" })
    expect(await connectAdminWallet()).toBe("0xd96dc67ae64ee202")
    expect(fcl.put).toHaveBeenCalledWith("discovery.wallet", "https://fcl-discovery.onflow.org/authn")
  })

  it("connect without an address is an error", async () => {
    fcl.authenticate.mockResolvedValueOnce({ addr: null })
    await expect(connectAdminWallet()).rejects.toThrow(/did not return an address/)
    fcl.authenticate.mockResolvedValueOnce(undefined)
    await expect(connectAdminWallet()).rejects.toThrow(/did not return an address/)
  })

  it("disconnect unauthenticates", async () => {
    await disconnectAdminWallet()
    expect(fcl.unauthenticate).toHaveBeenCalled()
  })

  it("sends the batch transaction with the plan's arguments in order, and waits for the seal", async () => {
    fcl.mutate.mockResolvedValueOnce("tx1")
    fcl.onceSealed.mockResolvedValueOnce({ statusCode: 0, errorMessage: "" })
    const r = await sendDeliveryBatch({
      source: "0x00000000000000aa",
      kind: "linked",
      providerControllerID: "70",
      momentIDs: ["1", "2"],
      recipients: ["0x01", "0x02"],
    })
    expect(r).toEqual({ txId: "tx1" })
    const call = fcl.mutate.mock.calls[0][0] as { cadence: string; limit: number; args: (a: typeof fcl.arg, t: typeof fcl.t) => unknown[] }
    expect(call.cadence).toBe(DELIVER_BATCH_CADENCE)
    expect(call.limit).toBe(DELIVER_GAS_LIMIT)
    expect(call.args(fcl.arg, fcl.t)).toEqual([
      { value: "0x00000000000000aa", type: "Address" },
      { value: "70", type: "UInt64" },
      { value: ["1", "2"], type: "Array(UInt64)" },
      { value: ["0x01", "0x02"], type: "Array(Address)" },
    ])
    expect(fcl.tx).toHaveBeenCalledWith("tx1")
  })

  it("an 'own' batch (moments in the connected Flow Wallet) sends the own-collection transaction, with no child or controller", async () => {
    fcl.mutate.mockResolvedValueOnce("tx-own")
    fcl.onceSealed.mockResolvedValueOnce({ statusCode: 0, errorMessage: "" })
    await sendDeliveryBatch({ source: "0x00000000000000bb", kind: "own", providerControllerID: null, momentIDs: ["9"], recipients: ["0x03"] })
    const call = fcl.mutate.mock.calls.at(-1)![0] as { cadence: string; args: (a: typeof fcl.arg, t: typeof fcl.t) => unknown[] }
    expect(call.cadence).toBe(DELIVER_OWN_BATCH_CADENCE)
    expect(call.args(fcl.arg, fcl.t)).toEqual([
      { value: ["9"], type: "Array(UInt64)" },
      { value: ["0x03"], type: "Array(Address)" },
    ])
  })

  it("a reverted transaction is an error, never 'sent'", async () => {
    fcl.mutate.mockResolvedValueOnce("tx2")
    fcl.onceSealed.mockResolvedValueOnce({ statusCode: 1, errorMessage: "panic: Cannot withdraw: Moment is locked" })
    await expect(
      sendDeliveryBatch({ source: "0x00000000000000aa", kind: "linked", providerControllerID: "70", momentIDs: ["1"], recipients: ["0x01"] }),
    ).rejects.toThrow(/tx2 failed: panic: Cannot withdraw/)
    fcl.mutate.mockResolvedValueOnce("tx3")
    fcl.onceSealed.mockResolvedValueOnce({ statusCode: 1 })
    await expect(
      sendDeliveryBatch({ source: "0x00000000000000aa", kind: "linked", providerControllerID: "70", momentIDs: ["1"], recipients: ["0x01"] }),
    ).rejects.toThrow(/tx3 failed: status 1/)
  })

  const LINKED = { source: "0x00000000000000aa", kind: "linked" as const, providerControllerID: "70", momentIDs: ["1"], recipients: ["0x01"] }

  it("a transaction that was SUBMITTED but whose seal can't be read is UNCONFIRMED, never 'NOT sent' (iOS 'Load failed', 2026-10-03)", async () => {
    fcl.mutate.mockResolvedValueOnce("tx4")
    fcl.onceSealed.mockRejectedValue(new TypeError("Load failed"))
    const err = await sendDeliveryBatch(LINKED).catch((e) => e)
    fcl.onceSealed.mockReset()
    expect(err).toBeInstanceOf(SealUnconfirmedError)
    expect(err.txId).toBe("tx4")
    expect(err.message).toMatch(/tx4 was submitted/)
    expect(err.message).toMatch(/Do NOT send again/)
    expect(err.message).toMatch(/Load failed/)
  })

  it("a lost seal read is retried, and a seal on the retry is a normal success", async () => {
    fcl.mutate.mockResolvedValueOnce("tx5")
    fcl.onceSealed.mockRejectedValueOnce(new TypeError("Load failed")).mockResolvedValueOnce({ statusCode: 0, errorMessage: "" })
    expect(await sendDeliveryBatch(LINKED)).toEqual({ txId: "tx5" })
    expect(fcl.onceSealed).toHaveBeenCalledTimes(2)
  })

  it("a revert FCL reports by REJECTING onceSealed (TransactionError) is 'failed', not unconfirmed and not retried", async () => {
    fcl.mutate.mockResolvedValueOnce("tx6")
    const revert = Object.assign(new Error("[Error Code: 1101] panic: Cannot withdraw: Moment is locked"), { code: 1101, type: "CADENCE_RUNTIME_ERROR" })
    fcl.onceSealed.mockRejectedValueOnce(revert)
    const err = await sendDeliveryBatch(LINKED).catch((e) => e)
    expect(err).not.toBeInstanceOf(SealUnconfirmedError)
    expect(err.message).toMatch(/tx6 failed: .*Moment is locked/)
    expect(fcl.onceSealed).toHaveBeenCalledTimes(1)
  })

  it("a failure BEFORE submission stays a plain error (nothing was sent)", async () => {
    fcl.mutate.mockRejectedValueOnce(new TypeError("Load failed"))
    const err = await sendDeliveryBatch(LINKED).catch((e) => e)
    expect(err).not.toBeInstanceOf(SealUnconfirmedError)
    expect(err.message).toMatch(/^Load failed/)
    expect(fcl.tx).not.toHaveBeenCalled()
  })

  it("the network trace names the request that failed and the one the CSP blocked, then restores fetch", async () => {
    const listeners: Record<string, Array<(e: unknown) => void>> = {}
    const doc = {
      visibilityState: "visible",
      addEventListener: (t: string, f: (e: unknown) => void) => ((listeners[t] ??= []).push(f)),
      removeEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = (listeners[t] ?? []).filter((g) => g !== f)),
    }
    const realFetch = vi.fn((): Promise<Response> => Promise.reject(new TypeError("Load failed")))
    const win: { fetch: (input: string, init?: RequestInit) => Promise<Response>; location: { href: string } } = { fetch: realFetch, location: { href: "https://www.rippackscity.com/admin/giveaways" } }
    vi.stubGlobal("window", win)
    vi.stubGlobal("document", doc)
    try {
      const trace = startNetworkTrace()
      expect(win.fetch).not.toBe(realFetch)
      await expect(win.fetch("https://rest-mainnet.onflow.org/v1/accounts/0x3d0b274c80263484?expand=keys", { method: "get" })).rejects.toThrow("Load failed")
      for (const f of listeners.visibilitychange ?? []) {
        doc.visibilityState = "hidden"
        f({})
      }
      for (const f of listeners.securitypolicyviolation ?? []) f({ blockedURI: "https://example-payer.test/sign", effectiveDirective: "connect-src" })
      const d = trace.describe()
      expect(d).toContain("request failed: GET rest-mainnet.onflow.org/v1/accounts/0x3d0b274c80263484")
      expect(d).not.toContain("expand=keys")
      expect(d).toContain("blocked by the page's security policy: https://example-payer.test/sign by connect-src")
      expect(d).toContain("in the background")
      trace.stop()
      expect(win.fetch).toBe(realFetch)
      expect(listeners.securitypolicyviolation).toEqual([])
      expect(listeners.visibilitychange).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("giveaways/admin-wallet — the trace records what FCL only LOGS, and the wallet's messages", () => {
  it("captures console errors/warnings and FCL window messages while signing, then restores both", () => {
    const handlers: Array<(e: unknown) => void> = []
    const win = {
      fetch: vi.fn(),
      location: { href: "https://www.rippackscity.com/admin/giveaways" },
      addEventListener: (_t: string, f: (e: unknown) => void) => handlers.push(f),
      removeEventListener: (_t: string, f: (e: unknown) => void) => handlers.splice(handlers.indexOf(f), 1),
    }
    const doc = { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal("window", win)
    vi.stubGlobal("document", doc)
    const realError = console.error
    const realWarn = console.warn
    console.error = vi.fn()
    console.warn = vi.fn()
    const quietError = console.error
    const quietWarn = console.warn
    try {
      const trace = startNetworkTrace()
      console.error("FCL authz failed:", new Error("Extension not found"))
      console.warn({ code: 7 })
      for (let i = 0; i < 5; i++) console.error(`extra ${i}`)
      for (const h of handlers) {
        h({ data: { type: "FCL:VIEW:READY" } })
        h({ data: { type: "not-fcl" } })
        h({ data: null })
      }
      expect(trace.logged()).toEqual(["FCL authz failed: Extension not found", '{"code":7}', "extra 0"])
      expect(trace.seen()).toEqual(["FCL:VIEW:READY"])
      expect(quietError).toHaveBeenCalled() // still reaches the real console
      trace.stop()
      expect(console.error).toBe(quietError)
      expect(console.warn).toBe(quietWarn)
      expect(handlers).toHaveLength(0)
    } finally {
      console.error = realError
      console.warn = realWarn
      vi.unstubAllGlobals()
    }
  })
})

describe("giveaways/admin-wallet — where the wallet will ask (Trevor, test2 2026-10-04: \"It's not doing anything now\")", () => {
  const BATCH = { source: "0x00000000000000aa", kind: "linked" as const, providerControllerID: "70", momentIDs: ["1"], recipients: ["0x01"] }

  it("names the channel from FCL's authz service method", () => {
    expect(channelOf([{ type: "authn", method: "WC/RPC" }, { type: "authz", method: "WC/RPC" }])).toBe("phone")
    expect(channelOf([{ type: "authz", method: "EXT/RPC" }])).toBe("extension")
    expect(channelOf([{ type: "authz", method: "POP/RPC" }])).toBe("popup")
    expect(channelOf([{ type: "authz", method: "HTTP/POST" }])).toBe("popup")
    expect(channelOf([{ type: "authn", method: "EXT/RPC" }])).toBe("extension") // no authz: fall back to authn
    expect(channelOf(undefined)).toBe("unknown")
    expect(channelOf([{ type: "authz", method: "SOMETHING/NEW" }])).toBe("unknown")
  })

  it("says where to look, and what the page is still waiting on or was blocked from", () => {
    expect(slowWalletHint("phone", [], [])).toMatch(/Flow Wallet app on your phone/)
    // the extension answered something but no prompt is visible: bring its window forward
    expect(slowWalletHint("extension", [], [], { seen: ["FCL:VIEW:READY"] })).toMatch(/extension icon/)
    // the extension never answered the page at all (Trevor's desktop, 2026-10-04): unlock / reload it
    expect(slowWalletHint("extension", [], [])).toMatch(/has not answered this page at all.*reload the extension/)
    expect(slowWalletHint("popup", [], [])).toMatch(/blocked-popup icon/)
    expect(slowWalletHint("unknown", [], [])).toMatch(/phone app, or the browser extension/)
    const h = slowWalletHint("phone", ["POST lilico.app/api/wc/payer"], ["https://x.example by connect-src"])
    expect(h).toContain("Still waiting on: POST lilico.app/api/wc/payer.")
    expect(h).toContain("Blocked by the page's security policy: https://x.example by connect-src.")
    const e = slowWalletHint("extension", [], [], { seen: ["FCL:VIEW:READY"], logged: ["Error: Declined: Externally Halted"] })
    expect(e).toContain("Wallet messages seen: FCL:VIEW:READY.")
    expect(e).toContain("Logged: Error: Declined: Externally Halted")
  })

  it("the hint still comes when reading the wallet session itself hangs (the timer starts first)", async () => {
    fcl.currentUser.snapshot.mockImplementationOnce(() => new Promise(() => undefined))
    let answer: (id: string) => void = () => undefined
    fcl.mutate.mockImplementationOnce(() => new Promise<string>((r) => (answer = r)))
    fcl.onceSealed.mockResolvedValue({ statusCode: 0, errorMessage: "" })
    const hints: string[] = []
    const p = sendDeliveryBatch(BATCH, { onSlow: (h) => hints.push(h), slowMs: 5 })
    await new Promise((r) => setTimeout(r, 40))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toMatch(/phone app, or the browser extension/)
    await new Promise((r) => setTimeout(r, 1_600)) // the session read gives up; the send proceeds
    answer("tx-hung-snapshot")
    await expect(p).resolves.toEqual({ txId: "tx-hung-snapshot" })
  })

  it("a prompt left unanswered gets ONE hint naming the phone when connected by QR code; a quick answer gets none", async () => {
    fcl.currentUser.snapshot.mockResolvedValue({ services: [{ type: "authz", method: "WC/RPC" }] })
    let answer: (id: string) => void = () => undefined
    fcl.mutate.mockImplementationOnce(() => new Promise<string>((r) => (answer = r)))
    fcl.onceSealed.mockResolvedValue({ statusCode: 0, errorMessage: "" })
    const hints: string[] = []
    const p = sendDeliveryBatch(BATCH, { onSlow: (h) => hints.push(h), slowMs: 5 })
    await new Promise((r) => setTimeout(r, 30))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toMatch(/Flow Wallet app on your phone/)
    answer("tx-slow")
    await expect(p).resolves.toEqual({ txId: "tx-slow" })

    fcl.mutate.mockResolvedValueOnce("tx-fast")
    const quick: string[] = []
    await sendDeliveryBatch(BATCH, { onSlow: (h) => quick.push(h), slowMs: 20 })
    await new Promise((r) => setTimeout(r, 40))
    expect(quick).toEqual([]) // the timer is cleared once the wallet answers
    fcl.currentUser.snapshot.mockResolvedValue({})
  })
})
