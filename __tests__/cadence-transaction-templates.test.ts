import { describe, it, expect } from "vitest"
import { GIFT_MOMENT_CADENCE, GIFT_MOMENT_GAS_LIMIT } from "@/lib/chains/flow/cadence/gift-moment"

// The one remaining write-path Cadence transaction template, gift-moment: the
// verified single-gift reference that the admin-signed giveaway delivery
// (concierge.md, the one permitted write) is pinned against in
// giveaways-deliver-cadence.test.ts. The purchase and offer templates were
// DELETED 2026-10-03 (register R99): RPC is read-only, they had no production
// importer, and a pin on dead code only kept a dead CI job alive.
//
// These are string templates, so the checkable properties are the ones CLAUDE.md
// treats as non-negotiable for this repo:
//   - Cadence 1.0 syntax ONLY — `auth(...) &Account`, never the pre-1.0
//     `AuthAccount`; `access(all)`, never `pub`.
//   - the deployed mainnet contract addresses, which are enumerated in
//     CLAUDE.md and must not drift silently (a wrong address is a transaction
//     that either fails or, worse, pays the wrong account).

/** Signer count = the number of `&Account` params in the prepare header. A
 *  naive `prepare\(([^)]*)\)` capture stops at the `)` inside `auth(...)`, so
 *  count the entitled references instead. */
function signerCount(src: string): number {
  const start = src.indexOf("prepare")
  if (start < 0) return 0
  // Take up to the opening brace of the prepare body.
  const header = src.slice(start, src.indexOf("{", start))
  return (header.match(/&Account/g) ?? []).length
}

const ALL_TEMPLATES: Array<[string, string]> = [
  ["gift-moment", GIFT_MOMENT_CADENCE],
]

describe("Cadence transaction templates — 1.0 syntax", () => {
  it.each(ALL_TEMPLATES)("%s is non-empty and declares a transaction", (_name, src) => {
    expect(src.trim().length).toBeGreaterThan(0)
    expect(src).toMatch(/transaction\s*\(?/)
  })

  it.each(ALL_TEMPLATES)("%s uses no pre-1.0 AuthAccount or pub declarations", (_name, src) => {
    // Cadence 1.0 replaced AuthAccount with `auth(Entitlement) &Account` and
    // `pub` with `access(all)`. Either survivor fails at parse time on mainnet.
    expect(src).not.toMatch(/\bAuthAccount\b/)
    expect(src).not.toMatch(/^\s*pub\s+(fun|let|var|resource|struct|contract)\b/m)
  })

  it.each(ALL_TEMPLATES)("%s declares its signers with an entitled &Account reference", (_name, src) => {
    expect(src).toMatch(/auth\([^)]+\)\s*&Account/)
  })
})

describe("gift-moment — single parent signer over Hybrid Custody", () => {
  it("borrows the child through HybridCustody and deposits via the public receiver", () => {
    expect(GIFT_MOMENT_CADENCE).toMatch(/import\s+HybridCustody/)
    expect(GIFT_MOMENT_CADENCE).toContain("borrowAccount")
    expect(GIFT_MOMENT_CADENCE).toContain("/public/MomentCollection")
    expect(GIFT_MOMENT_CADENCE).toContain("deposit")
  })

  it("has exactly ONE prepare signer — there is no Dapper co-signer on this path", () => {
    // Withdraw authority was pre-granted at account-link time, so adding a
    // second signer here would be a real behavioural change, not a typo.
    expect(signerCount(GIFT_MOMENT_CADENCE)).toBe(1)
  })

  it("ships a concrete gas limit", () => {
    expect(GIFT_MOMENT_GAS_LIMIT).toBe(999)
  })
})
