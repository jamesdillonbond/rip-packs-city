import { describe, it, expect } from "vitest"
import { generateKeyPairSync, sign } from "node:crypto"
import { verifyDiscordRequest } from "@/lib/alerts/discord-verify"

// verifyDiscordRequest wraps a raw 32-byte hex Ed25519 public key in the fixed
// SPKI/DER prefix and verifies Discord's sig over (timestamp + rawBody). It must
// NEVER throw: every malformed input (empty field, bad-length key/sig, bad hex,
// tampered message) resolves to false so the route can return 401. We mint a real
// Ed25519 keypair to exercise the true path, then flip each guard to false.

function makeSigned(body: string, timestamp = "1700000000") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const der = publicKey.export({ type: "spki", format: "der" })
  const publicKeyHex = Buffer.from(der.subarray(der.length - 32)).toString("hex")
  const signatureHex = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex")
  return { publicKeyHex, signatureHex, timestamp, rawBody: body }
}

describe("verifyDiscordRequest", () => {
  it("returns true for a genuinely-signed request", () => {
    const args = makeSigned(JSON.stringify({ type: 1 }))
    expect(verifyDiscordRequest(args)).toBe(true)
  })

  it("returns false when the body is tampered after signing", () => {
    const args = makeSigned(JSON.stringify({ type: 1 }))
    expect(verifyDiscordRequest({ ...args, rawBody: JSON.stringify({ type: 2 }) })).toBe(false)
  })

  it("returns false when the timestamp is altered", () => {
    const args = makeSigned(JSON.stringify({ type: 1 }))
    expect(verifyDiscordRequest({ ...args, timestamp: "1700000001" })).toBe(false)
  })

  it("returns false when signed by a different key", () => {
    const a = makeSigned(JSON.stringify({ type: 1 }))
    const b = makeSigned(JSON.stringify({ type: 1 }))
    // Valid signature from b's key, but a's public key.
    expect(verifyDiscordRequest({ ...a, signatureHex: b.signatureHex })).toBe(false)
  })

  it("returns false on empty publicKeyHex / signatureHex / timestamp", () => {
    const args = makeSigned(JSON.stringify({ type: 1 }))
    expect(verifyDiscordRequest({ ...args, publicKeyHex: "" })).toBe(false)
    expect(verifyDiscordRequest({ ...args, signatureHex: "" })).toBe(false)
    expect(verifyDiscordRequest({ ...args, timestamp: "" })).toBe(false)
  })

  it("returns false for a signature that is not 64 bytes", () => {
    const args = makeSigned(JSON.stringify({ type: 1 }))
    expect(verifyDiscordRequest({ ...args, signatureHex: "abcd" })).toBe(false)
  })

  it("returns false for a public key that is not 32 bytes (rawHexToPublicKey throws → caught)", () => {
    const args = makeSigned(JSON.stringify({ type: 1 }))
    expect(verifyDiscordRequest({ ...args, publicKeyHex: "abcdef" })).toBe(false)
  })

  it("returns false for non-hex garbage inputs without throwing", () => {
    expect(
      verifyDiscordRequest({
        publicKeyHex: "zzzz",
        signatureHex: "zzzz",
        timestamp: "1700000000",
        rawBody: "{}",
      })
    ).toBe(false)
  })
})
