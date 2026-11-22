import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// lib/candy/sale-buyer-paid.ts — a Candy sale is priced at WHAT THE BUYER PAID (Trevor 11-21).
// The fixtures are REAL mainnet transactions (trimmed to balances + keys), read 11-21:
//   skenes-m2        — 2025 All-Star ICONS 1/1 bought off a listing: listed 20.311, paid 22.749 SOL
//   dc-m2            — Absolute Batman #9 bought off a listing: listed 0.34, paid 0.3808 SOL
//   mmm-fill         — a card sold INTO a buyer's pool: the pool paid the price, the seller paid royalty
//   mmm-cancel-fill  — the same, with the seller's listing cancelled in the same transaction
// A pool fill must NOT be marked up (the buyer did not pay the royalty), and the closed listing
// account's rent must not read as the buyer funding it.

import { buyerPaidFromTx, runCandyBuyerPaid, candyAskBuyerCostUsd, CANDY_ME_LISTING_BUYER_MULTIPLIER } from "@/lib/candy/sale-buyer-paid"

const fx = (n: string) => JSON.parse(readFileSync(join(process.cwd(), "__tests__/fixtures/candy-buyer-paid", `${n}.json`), "utf8"))

describe("buyerPaidFromTx — on real transactions", () => {
  it("a listing bought outright: the buyer paid listed + royalty + fee (Skenes 1/1: 22.749 SOL, as the Candy bot reported)", () => {
    const r = buyerPaidFromTx(fx("skenes-m2"), { buyer: "EiWVtTQvUzMbcRwuyVPhLQKrjvbNUvFgBGmtTzsbjYB6", seller: "FjzzQ7yxv15xB2LwHbHnkqrYpqLJWLmUZvGubHf4QLi", listedSol: 20.31144211 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.paid_by).toBe("buyer")
    expect(r.buyer_paid_sol).toBeCloseTo(22.7488, 4)
    expect(r.ratio).toBeCloseTo(1.12, 4)
  })

  it("a DC listing bought outright is marked up the same way", () => {
    const r = buyerPaidFromTx(fx("dc-m2"), { buyer: "8v8CaQ4QyvqCqRCLftancEvVKWMPdSTciDXi1aSj28Wo", seller: "EhBMfL9m7hrXv1XC23h3HtJR2obJ7Hc9LvjTQX4pEuUK", listedSol: 0.34 })
    expect(r).toMatchObject({ ok: true, paid_by: "buyer" })
    if (r.ok) expect(r.buyer_paid_sol).toBeCloseTo(0.3808, 6)
  })

  it("a sale into a buyer's pool is NOT marked up: the seller's proceeds paid the royalty", () => {
    const r = buyerPaidFromTx(fx("mmm-fill"), { buyer: "HSqg6QEjbK5e2hpAGsC4nBqNZxq4ZRaPc15RVK3ciB3M", seller: "4KpvU8MxNWNT8g8MhgWa5kvjTFL3QykVZwPx6qTNzzQs", listedSol: 0.00366235 })
    expect(r).toMatchObject({ ok: true, paid_by: "seller", ratio: 1 })
  })

  it("a closed listing account's rent does not read as the buyer funding the royalty", () => {
    const r = buyerPaidFromTx(fx("mmm-cancel-fill"), { buyer: "GFGmpV5zJaF4enTZNLGbavHXCDiKorfDQCsRg8ZEjapg", seller: "9APjc3Hhqh5jt5dGbzW1eig36bCMh7rFaLUALthZL4nE", listedSol: 0.00343 })
    expect(r).toMatchObject({ ok: true, paid_by: "seller", ratio: 1 })
  })

  it("an implausible ratio is an error, never a price", () => {
    const r = buyerPaidFromTx(fx("skenes-m2"), { buyer: "EiWVtTQvUzMbcRwuyVPhLQKrjvbNUvFgBGmtTzsbjYB6", seller: "FjzzQ7yxv15xB2LwHbHnkqrYpqLJWLmUZvGubHf4QLi", listedSol: 5 })
    expect(r.ok).toBe(false)
  })

  it("a failed transaction is an error", () => {
    const t = fx("skenes-m2")
    t.meta.err = { InstructionError: [0, "x"] }
    expect(buyerPaidFromTx(t, { buyer: "a", seller: "b", listedSol: 1 })).toMatchObject({ ok: false, error: "tx_failed" })
  })
})

describe("candyAskBuyerCostUsd", () => {
  it("prices an ask at what its buyer would pay, on the same basis as buyer-paid sales", () => {
    expect(CANDY_ME_LISTING_BUYER_MULTIPLIER).toBe(1.12)
    expect(candyAskBuyerCostUsd(1, 100)).toBe(112)
    expect(candyAskBuyerCostUsd(1, null)).toBeNull()
  })
})

describe("runCandyBuyerPaid", () => {
  const SKENES = { transaction_hash: "SIG1", nft_id: "N1", sold_at: "2026-11-21T22:02:11+00:00", price_native: "20.31144211", buyer_address: "EiWVtTQvUzMbcRwuyVPhLQKrjvbNUvFgBGmtTzsbjYB6", seller_address: "FjzzQ7yxv15xB2LwHbHnkqrYpqLJWLmUZvGubHf4QLi" }
  const mkDb = (targets: any[], applied: any[]) => ({
    rpc: async (name: string, args: any) => {
      if (name === "candy_buyer_paid_targets") return { data: targets, error: null }
      if (name === "candy_apply_buyer_paid") { applied.push(...args.p_rows); return { data: args.p_rows.filter((r: any) => r.ratio && r.ratio !== 1).length, error: null } }
      return { data: null, error: null }
    },
  })
  const rpcOk = (tx: any) => async () => new Response(JSON.stringify({ result: tx }), { status: 200 })

  it("reads each transaction, offers the ratio per sale and counts what was re-priced", async () => {
    const applied: any[] = []
    const r = await runCandyBuyerPaid(mkDb([SKENES], applied), { budgetMs: 60_000, pauseMs: 0, fetchImpl: rpcOk(fx("skenes-m2")) as any, urls: ["u"] })
    expect(r).toMatchObject({ ok: true, targets: 1, read: 1, applied: 1, paid_by_buyer: 1 })
    expect(applied[0]).toMatchObject({ transaction_hash: "SIG1", nft_id: "N1", paid_by: "buyer", error: null })
    expect(applied[0].ratio).toBeCloseTo(1.12, 4)
  })

  it("a transaction the RPC does not have is retried later, not recorded", async () => {
    const applied: any[] = []
    const r = await runCandyBuyerPaid(mkDb([SKENES], applied), { budgetMs: 60_000, pauseMs: 0, fetchImpl: rpcOk(null) as any, urls: ["u"] })
    expect(r).toMatchObject({ ok: true, read: 0, not_found: 1 })
    expect(applied).toEqual([])
  })

  // 2026-11-22 (review): a JSON-RPC error that is not a rate limit (the pre-ca52dbbee "Transaction version (1) is
  // not supported") used to count as a refusal: 5 in a row stopped the run as budget_stopped with ok=true, forever.
  it("a JSON-RPC error that is not a rate limit is an error: counted, surfaced, the run is not ok, and it does not stop the run", async () => {
    const applied: any[] = []
    const many = Array.from({ length: 7 }, (_, i) => ({ ...SKENES, transaction_hash: `V${i}` }))
    const r = await runCandyBuyerPaid(mkDb(many, applied), { budgetMs: 60_000, pauseMs: 0, concurrency: 1, retryDelayMs: 0,
      fetchImpl: (async () => new Response(JSON.stringify({ error: { code: -32015, message: "Transaction version (1) is not supported" } }), { status: 200 })) as any, urls: ["u"] })
    expect(r.rpc_errors).toBe(7)
    expect(r.rate_limited).toBe(0)
    expect(r.budget_stopped).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Transaction version \(1\) is not supported/)
  })

  it("a JSON-RPC rate-limit error is still a refusal", async () => {
    const applied: any[] = []
    const r = await runCandyBuyerPaid(mkDb([SKENES], applied), { budgetMs: 60_000, pauseMs: 0, retryDelayMs: 0,
      fetchImpl: (async () => new Response(JSON.stringify({ error: { code: 429, message: "Too many requests" } }), { status: 200 })) as any, urls: ["u"] })
    expect(r).toMatchObject({ rate_limited: 1, rpc_errors: 0 })
  })

  it("a rate-limited RPC stops the run after 5 refusals and records nothing", async () => {
    const applied: any[] = []
    const many = Array.from({ length: 9 }, (_, i) => ({ ...SKENES, transaction_hash: `S${i}` }))
    let calls = 0
    const r = await runCandyBuyerPaid(mkDb(many, applied), { budgetMs: 60_000, pauseMs: 0, concurrency: 1, retryDelayMs: 0, fetchImpl: (async () => { calls++; return new Response("", { status: 429 }) }) as any, urls: ["u"] })
    expect(r.budget_stopped).toBe(true)
    expect(r.rate_limited).toBe(5)
    expect(calls).toBe(10) // each refusal is one read + one backed-off retry
    expect(applied).toEqual([])
  })

  it("reads in parallel batches but still stops at 5 refusals (never reads the whole backlog into a refusing RPC)", async () => {
    const applied: any[] = []
    const many = Array.from({ length: 40 }, (_, i) => ({ ...SKENES, transaction_hash: `S${i}` }))
    let calls = 0
    const r = await runCandyBuyerPaid(mkDb(many, applied), { budgetMs: 60_000, pauseMs: 0, concurrency: 4, retryDelayMs: 0, fetchImpl: (async () => { calls++; return new Response("", { status: 429 }) }) as any, urls: ["u"] })
    expect(r.budget_stopped).toBe(true)
    expect(r.rate_limited).toBe(5)
    expect(calls).toBeLessThanOrEqual(16)
    expect(applied).toEqual([])
  })

  it("a 429 followed by an answer on the retry is a read, not a refusal", async () => {
    const applied: any[] = []
    let calls = 0
    const r = await runCandyBuyerPaid(mkDb([SKENES], applied), {
      budgetMs: 60_000, pauseMs: 0, retryDelayMs: 0, urls: ["u"],
      fetchImpl: (async () => { calls++; return calls === 1 ? new Response("", { status: 429 }) : new Response(JSON.stringify({ result: fx("skenes-m2") }), { status: 200 }) }) as any,
    })
    expect(r).toMatchObject({ read: 1, rate_limited: 0, applied: 1 })
  })

  it("a failed apply fails the run", async () => {
    const db = { rpc: async (name: string) => name === "candy_buyer_paid_targets" ? { data: [SKENES], error: null } : { data: null, error: { message: "denied" } } }
    const r = await runCandyBuyerPaid(db, { budgetMs: 60_000, pauseMs: 0, fetchImpl: rpcOk(fx("skenes-m2")) as any, urls: ["u"] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("denied")
  })
})

// 2026-11-22: a version-1 transaction is REFUSED by the RPC unless the request allows version 1
// (the candy-chain-sales lane failed 5 collections on it), and this lane counted that refusal as
// `rate_limited` — a v1 sale would never resolve. The request now allows version 1.
describe("runCandyBuyerPaid — version-1 transactions", () => {
  it("asks for maxSupportedTransactionVersion 1, so a v1 sale is read rather than refused", async () => {
    const applied: any[] = []
    const SK = { transaction_hash: "SIG1", nft_id: "N1", sold_at: "2026-11-21T22:02:11+00:00", price_native: "20.31144211", buyer_address: "EiWVtTQvUzMbcRwuyVPhLQKrjvbNUvFgBGmtTzsbjYB6", seller_address: "FjzzQ7yxv15xB2LwHbHnkqrYpqLJWLmUZvGubHf4QLi" }
    const db = { rpc: async (name: string, args: any) => {
      if (name === "candy_buyer_paid_targets") return { data: [SK], error: null }
      if (name === "candy_apply_buyer_paid") { applied.push(...args.p_rows); return { data: 1, error: null } }
      return { data: null, error: null }
    } }
    const seen: any[] = []
    const v1Fetch = async (_u: string, init: any) => {
      const body = JSON.parse(init.body)
      seen.push(body.params[1])
      if (!(Number(body.params[1]?.maxSupportedTransactionVersion) >= 1)) return new Response(JSON.stringify({ error: { code: -32015, message: "Transaction version (1) is not supported" } }), { status: 200 })
      return new Response(JSON.stringify({ result: { ...fx("skenes-m2"), version: 1 } }), { status: 200 })
    }
    const r = await runCandyBuyerPaid(db as any, { budgetMs: 60_000, pauseMs: 0, retryDelayMs: 0, fetchImpl: v1Fetch as any, urls: ["u"] })
    expect(seen.every((o) => o.maxSupportedTransactionVersion === 1)).toBe(true)
    expect(r).toMatchObject({ ok: true, read: 1, rate_limited: 0 })
    expect(applied[0]).toMatchObject({ transaction_hash: "SIG1", paid_by: "buyer" })
  })
})

