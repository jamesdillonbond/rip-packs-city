import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/evm-health (GET).
// Its own authorized() gate accepts only Bearer RPC_ADMIN_TOKEN (or ?token=),
// fail-closed when unset. An unsupported ?chain= 400s before any RPC network
// call, so the real @/lib/evm-rpc slug set is exercised without mocking. The
// success / chain-id-mismatch / network-error legs (which do hit the RPC) are
// driven with the three @/lib/evm-rpc network reads mocked while getExpectedChainId
// + SUPPORTED_CHAIN_SLUGS stay REAL (so the expected id and slug set are genuine).

vi.mock("@/lib/evm-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/evm-rpc")>()
  return {
    ...actual,
    getChainId: vi.fn(),
    getBlockNumber: vi.fn(),
    getGasPriceWei: vi.fn(),
  }
})

import { GET } from "@/app/api/admin/evm-health/route"
import {
  getChainId,
  getBlockNumber,
  getGasPriceWei,
  getExpectedChainId,
} from "@/lib/evm-rpc"

const ADMIN = "test-admin-token"

function req(opts: { auth?: string; chain?: string } = {}): NextRequest {
  const url = new URL("https://t/api/admin/evm-health")
  if (opts.chain) url.searchParams.set("chain", opts.chain)
  const headers = new Headers()
  if (opts.auth) headers.set("authorization", opts.auth)
  return new NextRequest(url, { headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  vi.mocked(getChainId).mockReset()
  vi.mocked(getBlockNumber).mockReset()
  vi.mocked(getGasPriceWei).mockReset()
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("GET /api/admin/evm-health", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    const res = await req({ auth: `Bearer ${ADMIN}` })
    expect((await GET(res)).status).toBe(401)
  })

  it("401s on a wrong token", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    expect((await GET(req({ auth: "Bearer nope" }))).status).toBe(401)
  })

  it("accepts the ?token= query param as well as the Bearer header", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    // authed via query token but unsupported chain → 400 (proves auth passed).
    const url = new URL("https://t/api/admin/evm-health?token=" + ADMIN + "&chain=not-a-chain")
    const res = await GET(new NextRequest(url))
    expect(res.status).toBe(400)
  })

  it("400s on an unsupported chain slug (authed, pre-network)", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await GET(req({ auth: `Bearer ${ADMIN}`, chain: "not-a-chain" }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("Unsupported chain")
    expect(Array.isArray(body.supported)).toBe(true)
  })

  it("200 + ok:true when the reported chain_id matches the expected one", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const expected = getExpectedChainId("flow_evm_mainnet") // default chain, REAL value
    vi.mocked(getChainId).mockResolvedValue(expected)
    vi.mocked(getBlockNumber).mockResolvedValue(123456)
    vi.mocked(getGasPriceWei).mockResolvedValue(BigInt(2000000000)) // 2 gwei
    const res = await GET(req({ auth: `Bearer ${ADMIN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.chainIdMatches).toBe(true)
    expect(body.chainId).toBe(expected)
    expect(body.blockNumber).toBe(123456)
    expect(body.gasPriceWei).toBe("2000000000") // bigint serialized via .toString()
    expect(body.gasPriceGwei).toBe(2)
    expect(typeof body.latencyMs).toBe("number")
    expect(body.error).toBeUndefined()
  })

  it("500 + ok:false with an explanatory error when the chain_id mismatches", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const expected = getExpectedChainId("flow_evm_mainnet")
    vi.mocked(getChainId).mockResolvedValue(expected + 1) // wrong network answered
    vi.mocked(getBlockNumber).mockResolvedValue(1)
    vi.mocked(getGasPriceWei).mockResolvedValue(BigInt(1))
    const res = await GET(req({ auth: `Bearer ${ADMIN}` }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.chainIdMatches).toBe(false)
    expect(body.error).toContain(`Expected chain_id ${expected}`)
  })

  it("500 with the thrown message when an RPC read fails", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    vi.mocked(getChainId).mockRejectedValue(new Error("evm rpc unreachable"))
    vi.mocked(getBlockNumber).mockResolvedValue(1)
    vi.mocked(getGasPriceWei).mockResolvedValue(BigInt(1))
    const res = await GET(req({ auth: `Bearer ${ADMIN}` }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe("evm rpc unreachable")
    expect(typeof body.latencyMs).toBe("number")
  })
})
