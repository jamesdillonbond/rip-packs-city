import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// The signature path for wallet verification (lib/auth/flow-signature.ts).
//
// The property that matters most here is NOT "a bad signature is rejected" —
// it is that a FAILED READ is never rendered as a rejection. Telling a user
// their own wallet did not verify, when in fact an access node 500'd, is the
// account-level false claim this codebase keeps finding (CLAUDE.md, honesty
// canon). So the unavailable cases assert the ABSENCE of the false claim, not
// the presence of an error string.

const SECRET = "x".repeat(64) // a real service-role key is a long JWT

async function load() {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SECRET)
  vi.resetModules()
  return await import("@/lib/auth/flow-signature")
}

/** A Flow REST answer: JSON string holding base64 JSON-Cadence. */
function chainSays(value: boolean): Response {
  const inner = Buffer.from(JSON.stringify({ type: "Bool", value }), "utf8").toString("base64")
  return new Response(JSON.stringify(inner), { status: 200 })
}

const ADDR = "0x3795d42c0fc3a373"
const SIG = [{ addr: ADDR, keyId: 0, signature: "abcdef0123456789" }]

beforeEach(() => vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SECRET))
afterEach(() => vi.unstubAllEnvs())

describe("the message a wallet is asked to sign", () => {
  it("is four short readable lines, so a user can consent to what they sign", async () => {
    const { makeChallenge } = await load()
    const c = makeChallenge(ADDR)!
    const lines = c.message.split("\n")
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe(`wallet: ${ADDR}`)
    expect(lines[1]).toBe("site: rippackscity.com")
    expect(lines[3]).toBe(`code: ${c.nonce}`)
    // Nothing opaque: no base64 blob, no JSON, no URL for a reader to squint at.
    expect(c.message).not.toMatch(/[{}]|https?:\/\//)
  })

  it("hex-encodes exactly that message, which is what FCL signs", async () => {
    const { makeChallenge } = await load()
    const c = makeChallenge(ADDR)!
    expect(Buffer.from(c.messageHex, "hex").toString("utf8")).toBe(c.message)
  })

  it("refuses anything that is not a Flow address", async () => {
    const { makeChallenge, normalizeFlowAddress } = await load()
    for (const bad of ["", "0x", "0xZZZZ", "0x3795d42c0fc3a3", "not-an-address", null, 12]) {
      expect(normalizeFlowAddress(bad)).toBeNull()
      expect(makeChallenge(bad)).toBeNull()
    }
    expect(normalizeFlowAddress("3795D42C0FC3A373")).toBe(ADDR)
  })
})

describe("the nonce", () => {
  it("is bound to BOTH the address and the issue time", async () => {
    const { nonceFor } = await load()
    const t = "2026-09-14T00:00:00.000Z"
    expect(nonceFor(ADDR, t)).toBe(nonceFor(ADDR, t)) // recomputable => stateless
    expect(nonceFor("0x0000000000000001", t)).not.toBe(nonceFor(ADDR, t))
    expect(nonceFor(ADDR, "2026-09-14T00:00:01.000Z")).not.toBe(nonceFor(ADDR, t))
  })

  it("depends on the secret, so a challenge cannot be minted without it", async () => {
    const { nonceFor } = await load()
    const t = "2026-09-14T00:00:00.000Z"
    const a = nonceFor(ADDR, t)
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "y".repeat(64))
    vi.resetModules()
    const { nonceFor: nonceFor2 } = await import("@/lib/auth/flow-signature")
    expect(nonceFor2(ADDR, t)).not.toBe(a)
  })

  it("fails closed when no secret is available, rather than using a constant", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "")
    vi.resetModules()
    const { makeChallenge } = await import("@/lib/auth/flow-signature")
    // A guessable nonce would let anyone pre-mint a challenge for someone
    // else's address — the one thing the nonce exists to prevent.
    expect(() => makeChallenge(ADDR)).toThrow(/signing secret/i)
  })
})

describe("verifyWalletSignature", () => {
  it("accepts a fresh, matching, chain-approved signature", async () => {
    const { makeChallenge, verifyWalletSignature } = await load()
    const c = makeChallenge(ADDR)!
    const fetchImpl = vi.fn(async () => chainSays(true)) as unknown as typeof fetch
    const out = await verifyWalletSignature(
      { address: ADDR, issuedAt: c.issuedAt, nonce: c.nonce, signatures: SIG },
      { fetchImpl }
    )
    expect(out).toEqual({ ok: true, address: ADDR })
  })

  it("asks the chain about the message it actually issued", async () => {
    const { makeChallenge, verifyWalletSignature, FCL_CRYPTO_ADDRESS } = await load()
    const c = makeChallenge(ADDR)!
    let sent: { script: string; arguments: string[] } | null = null
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return chainSays(true)
    }) as unknown as typeof fetch
    await verifyWalletSignature(
      { address: ADDR, issuedAt: c.issuedAt, nonce: c.nonce, signatures: SIG },
      { fetchImpl }
    )
    const script = Buffer.from(sent!.script, "base64").toString("utf8")
    expect(script).toContain(`import FCLCrypto from ${FCL_CRYPTO_ADDRESS}`)
    expect(script).toContain("verifyUserSignatures")
    const messageArg = JSON.parse(Buffer.from(sent!.arguments[1], "base64").toString("utf8"))
    expect(messageArg.value).toBe(c.messageHex)
  })

  it("rejects an expired challenge without asking the chain", async () => {
    const { makeChallenge, verifyWalletSignature, CHALLENGE_TTL_MS } = await load()
    const c = makeChallenge(ADDR)!
    const fetchImpl = vi.fn(async () => chainSays(true)) as unknown as typeof fetch
    const out = await verifyWalletSignature(
      { address: ADDR, issuedAt: c.issuedAt, nonce: c.nonce, signatures: SIG },
      { fetchImpl, now: Date.parse(c.issuedAt) + CHALLENGE_TTL_MS + 1 }
    )
    expect(out.ok).toBe(false)
    expect(out).toMatchObject({ code: "expired" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("rejects a nonce it never issued", async () => {
    const { makeChallenge, verifyWalletSignature } = await load()
    const c = makeChallenge(ADDR)!
    const fetchImpl = vi.fn(async () => chainSays(true)) as unknown as typeof fetch
    const out = await verifyWalletSignature(
      { address: ADDR, issuedAt: c.issuedAt, nonce: "f".repeat(32), signatures: SIG },
      { fetchImpl }
    )
    expect(out).toMatchObject({ ok: false, code: "mismatch" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("will not let one address's challenge be answered for another", async () => {
    const { makeChallenge, verifyWalletSignature } = await load()
    const other = "0xb102f2ee797c9023"
    const c = makeChallenge(ADDR)!
    const fetchImpl = vi.fn(async () => chainSays(true)) as unknown as typeof fetch
    const out = await verifyWalletSignature(
      { address: other, issuedAt: c.issuedAt, nonce: c.nonce, signatures: SIG },
      { fetchImpl }
    )
    expect(out).toMatchObject({ ok: false, code: "mismatch" })
  })

  it("ignores a co-signature from a linked account rather than asking the wrong question", async () => {
    const { makeChallenge, verifyWalletSignature } = await load()
    const c = makeChallenge(ADDR)!
    const fetchImpl = vi.fn(async () => chainSays(true)) as unknown as typeof fetch
    // Only a foreign signature present: nothing FROM this address was offered,
    // so the chain is never asked and the answer is a definite no.
    const out = await verifyWalletSignature(
      {
        address: ADDR,
        issuedAt: c.issuedAt,
        nonce: c.nonce,
        signatures: [{ addr: "0xb102f2ee797c9023", keyId: 0, signature: "abcd" }],
      },
      { fetchImpl }
    )
    expect(out).toMatchObject({ ok: false, code: "unverified" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("reports a chain NO as unverified", async () => {
    const { makeChallenge, verifyWalletSignature } = await load()
    const c = makeChallenge(ADDR)!
    const fetchImpl = vi.fn(async () => chainSays(false)) as unknown as typeof fetch
    const out = await verifyWalletSignature(
      { address: ADDR, issuedAt: c.issuedAt, nonce: c.nonce, signatures: SIG },
      { fetchImpl }
    )
    expect(out).toMatchObject({ ok: false, code: "unverified" })
  })
})

describe("a failed read is never rendered as a rejection", () => {
  // Each case asserts the ABSENCE of the false claim (`code: "unverified"`),
  // not the presence of a particular message — the message can be reworded,
  // the false claim is the defect.
  const cases: Array<[string, () => typeof fetch]> = [
    ["access node 500", () => (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch],
    ["access node 429", () => (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch],
    ["network error", () => (async () => { throw new Error("ECONNRESET") }) as unknown as typeof fetch],
    ["undecodable body", () => (async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch],
  ]

  for (const [name, mk] of cases) {
    it(`${name} raises unavailable, not "did not verify"`, async () => {
      const { makeChallenge, verifyWalletSignature, FlowVerifyUnavailable } = await load()
      const c = makeChallenge(ADDR)!
      let threw: unknown = null
      let returned: unknown = null
      try {
        returned = await verifyWalletSignature(
          { address: ADDR, issuedAt: c.issuedAt, nonce: c.nonce, signatures: SIG },
          { fetchImpl: mk() }
        )
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(FlowVerifyUnavailable)
      // The absence of the false claim, stated directly:
      expect(returned).toBeNull()
    })
  }
})
