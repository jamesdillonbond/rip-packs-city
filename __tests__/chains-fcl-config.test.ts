import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Pins lib/chains/flow/fcl-config.ts — the SINGLE owner of FCL wallet discovery
// (see __tests__/fcl-discovery-single-owner.test.ts for the ownership invariant).
//
// Asserts: the exact config keys/values pushed, the intent -> discovery-endpoint
// mapping (sign-in and transact are SELF-CUSTODY; only "dapper-custodial" gets
// Dapper's restricted endpoint), env overrides vs defaults, the discovery exclude
// list, per-intent idempotency + intent switching, and the embedded fetchNonce
// resolver's ok / !ok / missing-nonce branches.

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

const SELF_CUSTODY = "https://fcl-discovery.onflow.org/authn"
const DAPPER_RESTRICTED = "https://accounts.meetdapper.com/fcl/authn-restricted"

const ENV_KEYS = [
  "NEXT_PUBLIC_FCL_ACCESS_NODE",
  "NEXT_PUBLIC_FCL_DISCOVERY_WALLET",
  "NEXT_PUBLIC_FCL_DISCOVERY_EXCLUDE",
]
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

async function freshModule() {
  vi.resetModules()
  return await import("@/lib/chains/flow/fcl-config")
}

describe("configureFcl — config keys", () => {
  it("pushes the expected mainnet config with default access node on first call", async () => {
    const { configureFcl } = await freshModule()
    configureFcl()

    const m = putsMap()
    expect(m["flow.network"]).toBe("mainnet")
    expect(m["accessNode.api"]).toBe("https://rest-mainnet.onflow.org")
    expect(m["discovery.wallet.method"]).toBe("POP/RPC")
    expect(m["app.detail.title"]).toBe("Rip Packs City")
    expect(m["app.detail.icon"]).toBe("https://www.rippackscity.com/icon.png")
    expect(typeof m["fcl.accountProof.resolver"]).toBe("function")
  })

  it("honors NEXT_PUBLIC_FCL_ACCESS_NODE and NEXT_PUBLIC_FCL_DISCOVERY_WALLET overrides", async () => {
    process.env.NEXT_PUBLIC_FCL_ACCESS_NODE = "https://custom.node"
    process.env.NEXT_PUBLIC_FCL_DISCOVERY_WALLET = "https://custom.discovery/authn"
    const { configureFcl } = await freshModule()
    configureFcl()

    const m = putsMap()
    expect(m["accessNode.api"]).toBe("https://custom.node")
    expect(m["discovery.wallet"]).toBe("https://custom.discovery/authn")
  })

  it("the env discovery override wins even for the dapper-custodial intent", async () => {
    process.env.NEXT_PUBLIC_FCL_DISCOVERY_WALLET = "https://custom.discovery/authn"
    const { configureFcl } = await freshModule()
    configureFcl({ intent: "dapper-custodial" })
    expect(putsMap()["discovery.wallet"]).toBe("https://custom.discovery/authn")
  })
})

describe("configureFcl — intent maps to discovery endpoint", () => {
  it("defaults to SELF-CUSTODY discovery when no intent is given", async () => {
    const { configureFcl } = await freshModule()
    configureFcl()
    expect(putsMap()["discovery.wallet"]).toBe(SELF_CUSTODY)
  })

  it('intent "sign-in" uses SELF-CUSTODY discovery, not Dapper-restricted', async () => {
    const { configureFcl } = await freshModule()
    configureFcl({ intent: "sign-in" })
    const m = putsMap()
    expect(m["discovery.wallet"]).toBe(SELF_CUSTODY)
    expect(m["discovery.wallet"]).not.toBe(DAPPER_RESTRICTED)
  })

  it('intent "transact" uses SELF-CUSTODY discovery (the HC parent must sign)', async () => {
    const { configureFcl } = await freshModule()
    configureFcl({ intent: "transact" })
    expect(putsMap()["discovery.wallet"]).toBe(SELF_CUSTODY)
  })

  it('only intent "dapper-custodial" selects Dapper\'s restricted endpoint', async () => {
    const { configureFcl } = await freshModule()
    configureFcl({ intent: "dapper-custodial" })
    expect(putsMap()["discovery.wallet"]).toBe(DAPPER_RESTRICTED)
  })

  it("configureFclAuth() is a back-compat alias for the sign-in intent", async () => {
    const { configureFclAuth } = await freshModule()
    configureFclAuth()
    expect(putsMap()["discovery.wallet"]).toBe(SELF_CUSTODY)
  })
})

describe("configureFcl — discovery exclude list", () => {
  it("defaults to an empty exclude list (no wallet is hidden by accident)", async () => {
    const { configureFcl } = await freshModule()
    configureFcl()
    expect(putsMap()["discovery.authn.exclude"]).toEqual([])
  })

  it("parses NEXT_PUBLIC_FCL_DISCOVERY_EXCLUDE into a trimmed, non-empty address list", async () => {
    process.env.NEXT_PUBLIC_FCL_DISCOVERY_EXCLUDE = " 0x1111111111111111 , 0x2222222222222222 ,,"
    const { configureFcl } = await freshModule()
    configureFcl()
    expect(putsMap()["discovery.authn.exclude"]).toEqual([
      "0x1111111111111111",
      "0x2222222222222222",
    ])
  })
})

describe("configureFcl — idempotency and intent switching", () => {
  it("a repeat call with the SAME intent is a no-op", async () => {
    const { configureFcl } = await freshModule()
    configureFcl({ intent: "sign-in" })
    h.puts.length = 0
    configureFcl({ intent: "sign-in" })
    expect(h.puts.length).toBe(0)
  })

  it("switching intent rewrites ONLY the discovery keys, not the base config", async () => {
    const { configureFcl } = await freshModule()
    configureFcl({ intent: "sign-in" })
    h.puts.length = 0

    configureFcl({ intent: "dapper-custodial" })

    const keys = h.puts.map(([k]) => k)
    expect(keys).toEqual([
      "discovery.wallet",
      "discovery.wallet.method",
      "discovery.authn.exclude",
    ])
    // Base config must not be re-pushed — notably not a second accountProof resolver.
    expect(keys).not.toContain("accessNode.api")
    expect(keys).not.toContain("fcl.accountProof.resolver")
    expect(putsMap()["discovery.wallet"]).toBe(DAPPER_RESTRICTED)
  })

  it("switching back to a previously-applied intent re-applies that discovery", async () => {
    const { configureFcl } = await freshModule()
    configureFcl({ intent: "sign-in" })
    configureFcl({ intent: "dapper-custodial" })
    h.puts.length = 0
    configureFcl({ intent: "transact" })
    expect(putsMap()["discovery.wallet"]).toBe(SELF_CUSTODY)
  })
})

describe("configureFcl — embedded fetchNonce resolver", () => {
  async function getResolver(): Promise<() => Promise<any>> {
    const { configureFcl } = await freshModule()
    configureFcl()
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
