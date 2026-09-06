import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 2026-09-06 (known-issues #59, decision delegated by Trevor): the history
// routes gate on "SAVED on this account", NOT on "verified". Verification-by-
// listing lost its only data source (~08-28) so 0 wallets could verify, and
// every new user was locked out of Pack History + Transaction History — pages
// that show public on-chain data. This is a BAN AT ZERO on the old predicate
// across the four routes, plus a positive control that the ownership check
// itself is still there (dropping the gate must not become dropping the auth).

const ROUTES = [
  "app/api/wallet/pack-history/route.ts",
  "app/api/wallet/transaction-history/route.ts",
  "app/api/wallet/pack-summary/route.ts",
  "app/api/wallet/pack-lifecycle/route.ts",
]

describe("history routes gate on saved wallets, not verified ones", () => {
  it("inspects all four routes", () => {
    expect(ROUTES.length).toBe(4)
  })
  for (const rel of ROUTES) {
    const src = readFileSync(join(process.cwd(), rel), "utf8")
    it(`${rel} does not filter saved_wallets on verified_at`, () => {
      expect(src).not.toMatch(/\.not\(\s*["']verified_at["']/)
      expect(src).not.toContain("wallet not verified on this account")
    })
    it(`${rel} still requires the wallet to be on the caller's account`, () => {
      expect(src).toContain('.from("saved_wallets")')
      expect(src).toMatch(/\.eq\(\s*["']user_id["']\s*,\s*user\.id\s*\)/)
      expect(src).toMatch(/\.eq\(\s*["']wallet_addr["']\s*,\s*wallet\s*\)/)
    })
  }
})
