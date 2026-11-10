import { describe, it, expect, vi } from "vitest"

/**
 * #228 lever (b′): a route whose RPC is measured to COMPLETE past the 8 s boundedRead default
 * gets a raised read budget (2026-11-10: /api/wallet-summary, /api/wallet/pack-summary,
 * /api/wallet/pack-history). The lever is only honest while the budget sits
 *   · above the 8 s default (or it changes nothing),
 *   · below the service_role 30 s statement_timeout (so a stuck read is still OUR retryable 503,
 *     not a platform kill), and
 *   · below the route's own maxDuration (or Vercel kills the function before the branch runs —
 *     a 504 in place of the honest answer).
 * Read from the route modules themselves, so a later edit to one number without the others reds here.
 */

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: () => ({}), from: () => ({}) } }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: () => ({}), from: () => ({}) }) }))
vi.mock("@/lib/auth/supabase-server", () => ({ requireUser: async () => ({ id: "u" }) }))

const DEFAULT_MS = 8_000
const SERVICE_ROLE_STATEMENT_TIMEOUT_MS = 30_000

describe("raised wallet read budgets", () => {
  const cases: [string, () => Promise<Record<string, unknown>>, string][] = [
    ["/api/wallet-summary", () => import("@/app/api/wallet-summary/route"), "WALLET_SUMMARY_READ_BUDGET_MS"],
    ["/api/wallet/pack-summary", () => import("@/app/api/wallet/pack-summary/route"), "PACK_SUMMARY_READ_BUDGET_MS"],
    ["/api/wallet/pack-history", () => import("@/app/api/wallet/pack-history/route"), "PACK_HISTORY_READ_BUDGET_MS"],
  ]
  for (const [route, load, name] of cases) {
    it(`${route}: default < ${name} < min(30 s DB ceiling, maxDuration)`, async () => {
      const mod = await load()
      const budget = mod[name] as number
      const maxDuration = mod.maxDuration as number
      expect(typeof budget).toBe("number")
      expect(typeof maxDuration).toBe("number")
      expect(budget).toBeGreaterThan(DEFAULT_MS)
      expect(budget).toBeLessThan(SERVICE_ROLE_STATEMENT_TIMEOUT_MS)
      expect(budget).toBeLessThan(maxDuration * 1000)
    })
  }
})
