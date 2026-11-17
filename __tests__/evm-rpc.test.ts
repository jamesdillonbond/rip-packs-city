import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// lib/evm-rpc.ts — EVM JSON-RPC helper over the X-Proxy-Secret worker seam.
// Pins: env/legacy-env proxy config resolution + the not-configured throw,
// request encoding (jsonrpc/method/params/id + headers), hex→number/bigint
// decoding across every public read (chainId/blockNumber/gasPrice/balance/
// call/getLogs/getBlockByNumber), and the three failure branches (!res.ok,
// JSON-RPC error object, missing result). fetch is stubbed per-call.

const fetchMock = vi.fn()

// Keys we set/clear so each test controls proxy config with no leakage.
const ENV_KEYS = [
  "EVM_PROXY_URL_FLOW_EVM_MAINNET",
  "EVM_PROXY_SECRET_FLOW_EVM_MAINNET",
  "FLOWEVM_PROXY_URL",
  "FLOWEVM_PROXY_SECRET",
  "EVM_PROXY_URL_BASE_MAINNET",
  "EVM_PROXY_SECRET_BASE_MAINNET",
]

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

import {
  SUPPORTED_CHAIN_SLUGS,
  getExpectedChainId,
  getChainId,
  getBlockNumber,
  getGasPriceWei,
  getBalanceWei,
  ethCall,
  getLogs,
  getBlockByNumber,
} from "@/lib/evm-rpc"

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
  clearEnv()
  process.env.EVM_PROXY_URL_FLOW_EVM_MAINNET = "https://flow-evm.example/rpc"
  process.env.EVM_PROXY_SECRET_FLOW_EVM_MAINNET = "flow-secret"
  process.env.EVM_PROXY_URL_BASE_MAINNET = "https://base.example/rpc"
  process.env.EVM_PROXY_SECRET_BASE_MAINNET = "base-secret"
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearEnv()
})

describe("static chain metadata", () => {
  it("exposes both supported slugs with their canonical chain ids", () => {
    expect([...SUPPORTED_CHAIN_SLUGS].sort()).toEqual([
      "base_mainnet",
      "flow_evm_mainnet",
    ])
    expect(getExpectedChainId("flow_evm_mainnet")).toBe(747)
    expect(getExpectedChainId("base_mainnet")).toBe(8453)
  })
})

describe("proxy config resolution", () => {
  // ── flow_evm_mainnet no longer fails closed, and that is deliberate ────────
  // It used to throw here. Failing closed protects a SECRET; Flow EVM mainnet
  // publishes a free keyless read-only endpoint, so there is no secret to
  // protect and the only thing the throw bought was darkness: the proxy URL was
  // present-but-blank, so every call threw at config time, `evm_nft_transfers`
  // sat at 0 rows and no `%evm%` pipeline ever recorded a single start.
  // ⚠ base_mainnet still fails closed (test below) — its proxy carries a rate
  // limit quota, so silently falling back to a public endpoint would be wrong.
  it("falls back to the PUBLIC Flow EVM endpoint when no proxy is configured", async () => {
    delete process.env.EVM_PROXY_URL_FLOW_EVM_MAINNET
    delete process.env.EVM_PROXY_SECRET_FLOW_EVM_MAINNET
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: "0x2eb" }))

    await expect(getChainId("flow_evm_mainnet")).resolves.toBe(747)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://mainnet.evm.nodes.onflow.org")
    // No secret exists on the public path, so no secret-shaped header may be
    // sent — attaching one to a third-party host is how credentials leak to
    // endpoints that were never meant to see them.
    expect((init.headers as Record<string, string>)["X-Proxy-Secret"]).toBeUndefined()
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
  })

  it("prefers a configured proxy over the public endpoint", async () => {
    // Precedence matters: the fallback must never quietly override an operator's
    // deliberate proxy configuration.
    process.env.EVM_PROXY_URL_FLOW_EVM_MAINNET = "https://proxy.example/rpc"
    process.env.EVM_PROXY_SECRET_FLOW_EVM_MAINNET = "proxy-secret"
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: "0x2eb" }))

    await getChainId("flow_evm_mainnet")
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://proxy.example/rpc")
    expect((init.headers as Record<string, string>)["X-Proxy-Secret"]).toBe("proxy-secret")
  })

  it("a URL without its secret does NOT use the proxy — it uses the public endpoint", async () => {
    // Half a proxy config is not a proxy config: sending unauthenticated
    // requests to a private proxy would 401 every call.
    process.env.EVM_PROXY_URL_FLOW_EVM_MAINNET = "https://proxy.example/rpc"
    delete process.env.EVM_PROXY_SECRET_FLOW_EVM_MAINNET
    delete process.env.FLOWEVM_PROXY_SECRET
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: "0x2eb" }))

    await getChainId("flow_evm_mainnet")
    expect(fetchMock.mock.calls[0][0]).toBe("https://mainnet.evm.nodes.onflow.org")
  })

  it("falls back to the legacy FLOWEVM_* env vars when primary is unset", async () => {
    delete process.env.EVM_PROXY_URL_FLOW_EVM_MAINNET
    delete process.env.EVM_PROXY_SECRET_FLOW_EVM_MAINNET
    process.env.FLOWEVM_PROXY_URL = "https://legacy.example/rpc"
    process.env.FLOWEVM_PROXY_SECRET = "legacy-secret"
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: "0x2eb" }))

    const id = await getChainId("flow_evm_mainnet")
    expect(id).toBe(747)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://legacy.example/rpc")
    expect((init.headers as Record<string, string>)["X-Proxy-Secret"]).toBe("legacy-secret")
  })

  it("base_mainnet has no legacy fallback, so its error names only the primary var", async () => {
    delete process.env.EVM_PROXY_URL_BASE_MAINNET
    delete process.env.EVM_PROXY_SECRET_BASE_MAINNET
    await expect(getBlockNumber("base_mainnet")).rejects.toThrow(
      /Set EVM_PROXY_URL_BASE_MAINNET and matching secret/
    )
    // ensure the error does NOT mention an "or <legacy>" clause
    await expect(getBlockNumber("base_mainnet")).rejects.not.toThrow(/ or /)
  })
})

describe("request encoding", () => {
  it("POSTs a well-formed JSON-RPC envelope with content-type + proxy secret", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ jsonrpc: "2.0", id: 5, result: "0x0" })
    )
    await getBalanceWei("flow_evm_mainnet", "0xabc", "latest")

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://flow-evm.example/rpc")
    expect(init.method).toBe("POST")
    const headers = init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
    expect(headers["X-Proxy-Secret"]).toBe("flow-secret")

    const payload = JSON.parse(init.body as string)
    expect(payload.jsonrpc).toBe("2.0")
    expect(payload.method).toBe("eth_getBalance")
    expect(payload.params).toEqual(["0xabc", "latest"])
    expect(typeof payload.id).toBe("number")
    expect(Number.isFinite(payload.id)).toBe(true)
  })
})

describe("successful decode paths", () => {
  it("getChainId decodes hex → number", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: "0x2105" }))
    expect(await getChainId("base_mainnet")).toBe(8453)
  })

  it("getBlockNumber decodes hex → number", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: "0xff" }))
    expect(await getBlockNumber("flow_evm_mainnet")).toBe(255)
  })

  it("getGasPriceWei decodes hex → bigint", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: "0x3b9aca00" }))
    const v = await getGasPriceWei("flow_evm_mainnet")
    expect(v).toBe(BigInt("1000000000"))
    expect(typeof v).toBe("bigint")
  })

  it("getBalanceWei decodes hex → bigint and uses default block=latest", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }))
    const bal = await getBalanceWei("flow_evm_mainnet", "0xwallet")
    expect(bal).toBe(BigInt("1000000000000000000"))
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(payload.params).toEqual(["0xwallet", "latest"])
  })

  it("ethCall passes the call object + block and returns the raw hex result", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: "0xdeadbeef" }))
    const out = await ethCall(
      "base_mainnet",
      { to: "0xcontract", data: "0x1234", from: "0xsender" },
      "0x10"
    )
    expect(out).toBe("0xdeadbeef")
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(payload.method).toBe("eth_call")
    expect(payload.params).toEqual([
      { to: "0xcontract", data: "0x1234", from: "0xsender" },
      "0x10",
    ])
  })

  it("getLogs returns the log array from eth_getLogs", async () => {
    const logs = [
      { address: "0xa", topics: ["0xt"], data: "0x", blockNumber: "0x1", transactionHash: "0xh", transactionIndex: "0x0", blockHash: "0xb", logIndex: "0x0", removed: false },
    ]
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: logs }))
    const out = await getLogs("flow_evm_mainnet", { fromBlock: "0x1", toBlock: "0x2" })
    expect(out).toEqual(logs)
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(payload.method).toBe("eth_getLogs")
    expect(payload.params).toEqual([{ fromBlock: "0x1", toBlock: "0x2" }])
  })

  it("getBlockByNumber requests full=false and can return null", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: null }))
    const out = await getBlockByNumber("flow_evm_mainnet", "0x100")
    expect(out).toBeNull()
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(payload.method).toBe("eth_getBlockByNumber")
    expect(payload.params).toEqual(["0x100", false])
  })
})

describe("failure branches", () => {
  it("throws with status + body text when the proxy returns !ok", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => "bad gateway",
    })
    await expect(getChainId("flow_evm_mainnet")).rejects.toThrow(
      "flow_evm_mainnet proxy returned 502: bad gateway"
    )
  })

  it("throws when the JSON-RPC response carries an error object", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } })
    )
    await expect(ethCall("flow_evm_mainnet", { to: "0x", data: "0x" })).rejects.toThrow(
      "flow_evm_mainnet JSON-RPC error -32000: execution reverted"
    )
  })

  it("throws when the response has neither result nor error", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1 }))
    await expect(getBlockNumber("flow_evm_mainnet")).rejects.toThrow(
      "flow_evm_mainnet JSON-RPC returned no result and no error"
    )
  })
})
