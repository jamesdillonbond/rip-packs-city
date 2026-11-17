import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * /api/entity/team-checklist(-progress) and /api/entity/team-sets: the wallet param is parsed for the
 * collection's chain. A Solana key reaches the RPC VERBATIM (the RPC matches
 * `wallet_address = p_wallet` exactly, so a folded key reads "0 owned"); a Flow
 * key on a Solana collection is a 400, never a checklist with no owned flags.
 * The Flow arm is pinned unchanged.
 */

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return Promise.resolve({ data: fn.endsWith("_progress") ? { total: 1 } : [], error: null })
    },
  },
}))

import { GET as checklistGET } from "@/app/api/entity/team-checklist/route"
import { GET as progressGET } from "@/app/api/entity/team-checklist-progress/route"
import { GET as setsGET } from "@/app/api/entity/team-sets/route"

const SOL = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix"
const req = (q: string, route: string) => new Request(`https://t/api/entity/${route}?${q}`)

beforeEach(() => { rpcCalls.length = 0 })

for (const [name, GET, route] of [
  ["team-checklist", checklistGET, "team-checklist"],
  ["team-checklist-progress", progressGET, "team-checklist-progress"],
  ["team-sets", setsGET, "team-sets"],
] as const) {
  describe(`GET /api/entity/${name}`, () => {
    it("passes a Solana key VERBATIM on Candy", async () => {
      const r = await GET(req(`collection=candy-mlb&slug=new-york-yankees&wallet=${SOL}`, route))
      expect(r.status).toBe(200)
      expect(rpcCalls[0].args.p_wallet).toBe(SOL)
      expect(rpcCalls[0].args.p_wallet).not.toBe(SOL.toLowerCase())
    })
    it("REFUSES a Flow key on Candy — no RPC is called", async () => {
      const r = await GET(req(`collection=candy-mlb&slug=new-york-yankees&wallet=0x0123456789abcdef`, route))
      expect(r.status).toBe(400)
      expect(rpcCalls).toHaveLength(0)
    })
    it("no-change arm: Top Shot lowercases a Flow key and ignores a non-Flow one", async () => {
      await GET(req(`collection=nba-top-shot&slug=portland-trail-blazers&wallet=0x0123456789ABCDEF`, route))
      expect(rpcCalls[0].args.p_wallet).toBe("0x0123456789abcdef")
      const r = await GET(req(`collection=nba-top-shot&slug=portland-trail-blazers&wallet=${SOL}`, route))
      expect(r.status).toBe(200)
      expect(rpcCalls[1].args.p_wallet).toBeNull()
    })
  })
}
