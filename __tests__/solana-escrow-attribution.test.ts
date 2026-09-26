import { describe, it, expect } from "vitest"
import { attributeEscrowHeldToSellers, MAGIC_EDEN_SOLANA_ESCROW as ESCROW } from "@/lib/chains/solana/escrow"

// Pins lib/chains/solana/escrow.ts: a card the chain says Magic Eden's escrow
// holds is a LISTED card, attributed to its listing's seller (2026-09-25).

function fake(pages: Array<{ data: unknown; error: unknown } | Error>) {
  const calls: Array<{ table: string; mints: string[]; active: unknown }> = []
  let n = 0
  return {
    calls,
    from(table: string) {
      const call = { table, mints: [] as string[], active: undefined as unknown }
      calls.push(call)
      const q: any = {
        select: () => q,
        in: (_c: string, v: string[]) => ((call.mints = v), q),
        eq: (_c: string, v: unknown) => {
          call.active = v
          const p = pages[n++] ?? { data: [], error: null }
          return p instanceof Error ? Promise.reject(p) : Promise.resolve(p)
        },
      }
      return q
    },
  }
}

const row = (w: string, m: string) => ({ wallet_address: w, moment_id: m, serial_number: 1 })

describe("attributeEscrowHeldToSellers", () => {
  it("makes no read when no row is escrow-held", async () => {
    const sb = fake([])
    const r = await attributeEscrowHeldToSellers(sb, [row("w1", "a")])
    expect(sb.calls).toHaveLength(0)
    expect(r).toMatchObject({ remapped: 0, unmatched: 0, error: null })
  })

  it("re-attributes to the MOST RECENTLY SEEN active listing's seller; others untouched", async () => {
    const sb = fake([{
      data: [
        { token_mint: "a", seller: "OldSeller", last_seen_at: "2026-08-01T00:00:00Z" },
        { token_mint: "a", seller: "NewSeller", last_seen_at: "2026-09-25T00:00:00Z" },
      ],
      error: null,
    }])
    const r = await attributeEscrowHeldToSellers(sb, [row(ESCROW, "a"), row("w1", "b")])
    expect(sb.calls[0]).toMatchObject({ table: "candy_listings", mints: ["a"], active: true })
    expect(r.rows.map((x) => x.wallet_address)).toEqual(["NewSeller", "w1"])
    expect(r).toMatchObject({ remapped: 1, unmatched: 0, error: null })
    // The other columns ride through unchanged.
    expect(r.rows[0]).toMatchObject({ moment_id: "a", serial_number: 1 })
  })

  it("never 'remaps' to the escrow itself or to a null seller", async () => {
    const sb = fake([{ data: [{ token_mint: "a", seller: ESCROW, last_seen_at: null }, { token_mint: "b", seller: null, last_seen_at: null }], error: null }])
    const r = await attributeEscrowHeldToSellers(sb, [row(ESCROW, "a"), row(ESCROW, "b")])
    expect(r.rows.every((x) => x.wallet_address === ESCROW)).toBe(true)
    expect(r).toMatchObject({ remapped: 0, unmatched: 2 })
  })

  it("a failed or thrown lookup returns the rows UNCHANGED and says why", async () => {
    for (const page of [{ data: null, error: { message: "timeout" } }, new Error("socket hang up")]) {
      const input = [row(ESCROW, "a")]
      const r = await attributeEscrowHeldToSellers(fake([page]), input)
      expect(r.rows).toBe(input)
      expect(r.error).toBeTruthy()
      expect(r.remapped).toBe(0)
    }
  })

  it("compares the escrow VERBATIM — a case-folded address is a different wallet", async () => {
    const sb = fake([])
    const r = await attributeEscrowHeldToSellers(sb, [row(ESCROW.toLowerCase(), "a")])
    expect(sb.calls).toHaveLength(0)
    expect(r.remapped).toBe(0)
  })
})
