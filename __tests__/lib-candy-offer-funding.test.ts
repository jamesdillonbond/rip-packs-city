import { describe, it, expect } from "vitest"
import { isUnfundable, parseEscrowBalance, parseGetBalance } from "@/lib/candy/offer-funding"

describe("isUnfundable — positive evidence only", () => {
  it("both escrow and wallet below the bid → unfundable (the 11-20 drained-wallet case)", () => {
    expect(isUnfundable(0.3, { escrowSol: 0, walletSol: 0.00089 })).toBe(true)
  })
  it("either source covering the bid keeps it", () => {
    expect(isUnfundable(0.3, { escrowSol: 0.3, walletSol: 0 })).toBe(false)
    expect(isUnfundable(0.3, { escrowSol: 0, walletSol: 0.5 })).toBe(false)
  })
  it("an unknown read keeps the bid (fail open)", () => {
    expect(isUnfundable(0.3, { escrowSol: null, walletSol: 0 })).toBe(false)
    expect(isUnfundable(0.3, { escrowSol: 0, walletSol: null })).toBe(false)
    expect(isUnfundable(0.3, undefined)).toBe(false)
  })
  it("a non-positive or non-finite price is never judged", () => {
    expect(isUnfundable(0, { escrowSol: 0, walletSol: 0 })).toBe(false)
    expect(isUnfundable(Number.NaN, { escrowSol: 0, walletSol: 0 })).toBe(false)
  })
})

describe("balance parsers return null on any unrecognised shape", () => {
  it("escrow", () => {
    expect(parseEscrowBalance({ buyerEscrowBalance: 1.5 })).toBe(1.5)
    expect(parseEscrowBalance({ buyerEscrowBalance: "1.5" })).toBeNull()
    expect(parseEscrowBalance({})).toBeNull()
    expect(parseEscrowBalance(null)).toBeNull()
    expect(parseEscrowBalance({ buyerEscrowBalance: -1 })).toBeNull()
  })
  it("getBalance (lamports → SOL)", () => {
    expect(parseGetBalance({ result: { value: 890_000 } })).toBeCloseTo(0.00089)
    expect(parseGetBalance({ result: 5 })).toBeNull()
    expect(parseGetBalance({ error: { message: "x" } })).toBeNull()
  })
})
