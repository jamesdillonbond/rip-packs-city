import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Pins lib/chains/flow/fcl-config.ts — configureFclAuth(), the browser-side FCL
// setup for the account-proof auth flow. Previously 0% coverage. We mock
// @onflow/fcl so no real config runs, and assert: the exact config keys/values
// pushed, the access-node/discovery env overrides vs defaults, module-level
// idempotency (second call is a no-op), and the embedded fetchNonce resolver's
// ok / !ok / missing-nonce branches (extracted from the recorded config.put args).

const h = vi.hoisted(() => {
  const puts: Array<[string, unknown]> = []
  const cfg: any = {
    put: (k: string, v: unknown) => {
      puts.push([k, v])
      return cfg
    },
  }
  const configFn = vi.fn(() => cfg)
  return { puts, configFn }
})

vi.mock("@onflow/fcl", () => ({ config: h.configFn }))

const ENV_KEYS = ["NEXT_PUBLIC_FCL_ACCESS_NODE", "NEXT_PUBLIC_FCL_DISCOVERY_WALLET"]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  h.puts.length = 0
  h.configFn.mockClear()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.unstubAllGlobals()
})

function putsMap(): Record<string, unknown> {
  return Object.fromEntries(h.puts)
}

describe("configureFclAuth — config keys", () => {
  it("pushes the expected mainnet config with default access node and discovery on first call", async () => {
    vi.resetModules()
    const { configureFclAuth } = await import("@/lib/chains/flow/fcl-config")
    configureFclAuth()

    const m = putsMap()
    expect(m["flow.network"]).toBe("mainnet")
    expect(m["accessNode.api"]).toBe("https://rest-mainnet.onflow.org")
    expect(m["discovery.wallet"]).toBe("https://fcl-discovery.onflow.org/authn")
    expect(m["discovery.wallet.method"]).toBe("POP/RPC")
    expect(m["app.detail.title"]).toBe("Rip Packs City")
    expect(m["app.detail.icon"]).toBe("https://www.rippackscity.com/icon.png")
    expect(typeof m["fcl.accountProof.resolver"]).toBe("function")
    expect(h.configFn).toHaveBeenCalledTimes(1)
  })

  it("honors NEXT_PUBLIC_FCL_ACCESS_NODE and NEXT_PUBLIC_FCL_DISCOVERY_WALLET overrides", async () => {
    vi.resetModules()
    process.env.NEXT_PUBLIC_FCL_ACCESS_NODE = "https://custom.node"
    process.env.NEXT_PUBLIC_FCL_DISCOVERY_WALLET = "https://custom.discovery/authn"
    const { configureFclAuth } = await import("@/lib/chains/flow/fcl-config")
    configureFclAuth()

    const m = putsMap()
    expect(m["accessNode.api"]).toBe("https://custom.node")
    expect(m["discovery.wallet"]).toBe("https://custom.discovery/authn")
  })

  it("is idempotent — a second call within the module lifetime is a no-op", async () => {
    vi.resetModules()
    const { configureFclAuth } = await import("@/lib/chains/flow/fcl-config")
    configureFclAuth()
    const firstCount = h.configFn.mock.calls.length
    h.puts.length = 0
    configureFclAuth()
    // Guarded by module-level `configured` flag: no additional config() call and
    // no additional puts on the second invocation.
    expect(h.configFn.mock.calls.length).toBe(firstCount)
    expect(h.puts.length).toBe(0)
  })
})

describe("configureFclAuth — embedded fetchNonce resolver", () => {
  async function getResolver(): Promise<() => Promise<any>> {
    vi.resetModules()
    const { configureFclAuth } = await import("@/lib/chains/flow/fcl-config")
    configureFclAuth()
    const entry = h.puts.find(([k]) => k === "fcl.accountProof.resolver")
    return entry![1] as () => Promise<any>
  }

  it("returns { appIdentifier, nonce } on a successful /api/auth/fcl-nonce response", async () => {
    const resolver = await getResolver()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ nonce: "abc123" }) }) as any),
    )
    const out = await resolver()
    expect(out).toEqual({ appIdentifier: "Rip Packs City", nonce: "abc123" })
  })

  it("throws on a non-2xx nonce response", async () => {
    const resolver = await getResolver()
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as any))
    await expect(resolver()).rejects.toThrow(/fcl-nonce HTTP 503/)
  })

  it("throws when the nonce is missing from the response body", async () => {
    const resolver = await getResolver()
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any))
    await expect(resolver()).rejects.toThrow(/returned no nonce/)
  })
})
