// @vitest-environment jsdom
// ⚠ jsdom is required for the storage block at the bottom: lib/owner-key.ts
// short-circuits to "" when `window` is undefined, so under the default node
// environment every read returns empty and the round-trip assertions fail
// against correct code — a false red that looks exactly like a real one.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  OWNER_KEY_STORAGE,
  ownerKeyStorageFor,
  ownerKeyMatchesChain,
  getOwnerKey,
  getOwnerKeyForChain,
  setOwnerKeyForChain,
} from "@/lib/owner-key"

// ⛔ WHAT THIS FILE EXISTS FOR. `rpc_owner_key` was a SINGLE global localStorage
// slot holding "the collector's wallet". That is coherent while every published
// collection is on one chain and incoherent the moment a second one ships.
// Measured 2026-09-19, the day Candy MLB's Collection tab went live:
//
//   * the only writer of the slot was gated on `startsWith("0x")`, so a Candy
//     base58 address was never written at all, and
//   * `/candy-mlb/market`'s Owned/Locked column, gated the same way, therefore
//     never called `/api/wallet/edition-counts` — a route that had been repaired
//     that same morning and verified live (editionCount 0 → 5). The fix was
//     inert because its CALLER could not reach it.
//
// ⚠ And the obvious repair — drop the `0x` gate — is worse than the bug: one
// global slot means a Flow collector who searches a Candy wallet has their Flow
// key OVERWRITTEN, and every `0x`-gated Flow surface (the sniper's owned-edition
// auto-load, Top Shot's own Owned column, the dashboard alerts key) silently
// goes blank. So the slot is chain-scoped, and the two properties below are what
// make that safe rather than merely different.

const MINT = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
const FLOW = "0xa1b2c3d4e5f60718"

describe("ownerKeyStorageFor — Flow keeps its slot, byte for byte", () => {
  // ⭐ THE NO-MIGRATION PROPERTY, and it is the reason this change is shippable
  // without touching a single existing reader. Every collector already signed in
  // on a Flow collection must keep working with no re-login and no backfill.
  it("Cadence collections resolve to the historical key", () => {
    expect(ownerKeyStorageFor("flow")).toBe(OWNER_KEY_STORAGE)
    expect(ownerKeyStorageFor("flow")).toBe("rpc_owner_key")
  })

  it("a collection with no on-chain wallet concept also keeps the historical key", () => {
    // dbChain null (e.g. RWA, unseeded) must not invent a slot nobody reads.
    expect(ownerKeyStorageFor(null)).toBe(OWNER_KEY_STORAGE)
    expect(ownerKeyStorageFor(undefined)).toBe(OWNER_KEY_STORAGE)
  })

  it("Solana gets its OWN slot, distinct from Flow's", () => {
    expect(ownerKeyStorageFor("solana")).not.toBe(OWNER_KEY_STORAGE)
    expect(ownerKeyStorageFor("solana")).toBe("rpc_owner_key_solana")
  })

  it("⚠ the slot is keyed by ChainKind, not dbChain — the EVM chains share one", () => {
    // ethereum / polygon / flow_evm are the same address space, so a collector
    // has ONE EVM identity. Keying on dbChain would split it into three slots
    // and the second EVM collection would read as "not signed in".
    expect(ownerKeyStorageFor("ethereum")).toBe(ownerKeyStorageFor("polygon"))
    expect(ownerKeyStorageFor("ethereum")).toBe(ownerKeyStorageFor("flow_evm"))
    expect(ownerKeyStorageFor("ethereum")).toBe("rpc_owner_key_evm")
  })
})

describe("ownerKeyMatchesChain — refuse cross-chain, but do NOT tighten Flow", () => {
  // ⭐ THE REGRESSION PIN. `isValidAddressForChain(key, "flow")` demands exactly
  // 16 hex digits — STRICTER than the `startsWith("0x")` this predicate
  // replaced. Adopting it on the Cadence arm would stop serving owned counts to
  // any collector whose stored key is non-canonical: a Flow regression smuggled
  // in under a Solana fix. Three existing component tests fail on that
  // tightening, which is how it was caught; this is the unit-level pin.
  it("the Cadence arm stays LOOSE — a non-canonical 0x key still matches", () => {
    expect(ownerKeyMatchesChain("0xmine", "flow")).toBe(true)
    expect(ownerKeyMatchesChain(FLOW, "flow")).toBe(true)
  })

  it("a Solana key must be a real base58 address, because that chain has no legacy keys to protect", () => {
    expect(ownerKeyMatchesChain(MINT, "solana")).toBe(true)
    expect(ownerKeyMatchesChain("nonsense", "solana")).toBe(false)
  })

  it("⛔ THE CROSS-CHAIN REFUSAL, both directions", () => {
    // A cross-chain wallet query does not error — it returns NOTHING, and
    // nothing renders as a confident zero. That is the failure this refuses.
    expect(ownerKeyMatchesChain(MINT, "flow")).toBe(false)
    expect(ownerKeyMatchesChain(FLOW, "solana")).toBe(false)
  })

  it("an empty key is not a wallet on any chain", () => {
    expect(ownerKeyMatchesChain("", "flow")).toBe(false)
    expect(ownerKeyMatchesChain("", "solana")).toBe(false)
  })
})

describe("the two slots do not disturb each other", () => {
  let store: Record<string, string>
  beforeEach(() => {
    store = {}
    // ⚠ `vi.stubGlobal("localStorage", …)` does NOT take in jsdom — the module
    // reads `localStorage`, which resolves to the `window` accessor property.
    // Defining it on `window` is what actually replaces it.
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = v },
        removeItem: (k: string) => { delete store[k] },
        clear: () => { store = {} },
      },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it("writing a Solana key leaves the Flow key — and getOwnerKey() — untouched", () => {
    setOwnerKeyForChain("flow", FLOW)
    setOwnerKeyForChain("solana", MINT)

    expect(getOwnerKeyForChain("flow")).toBe(FLOW)
    expect(getOwnerKeyForChain("solana")).toBe(MINT)
    // ⚠ The un-suffixed accessor is what every pre-existing Flow surface calls.
    // It must still see the Flow address after a Candy search, or the bug this
    // change exists to prevent has simply moved.
    expect(getOwnerKey()).toBe(FLOW)
  })

  it("⚠ base58 is CASE-SENSITIVE and must round-trip verbatim", () => {
    setOwnerKeyForChain("solana", MINT)
    expect(getOwnerKeyForChain("solana")).toBe(MINT)
    expect(getOwnerKeyForChain("solana")).not.toBe(MINT.toLowerCase())
  })

  it("an unset chain slot reads as empty, never as the other chain's key", () => {
    setOwnerKeyForChain("flow", FLOW)
    expect(getOwnerKeyForChain("solana")).toBe("")
  })
})

describe("clearAllOwnerKeys — sign-out has to take every chain with it", () => {
  let store: Record<string, string>
  beforeEach(() => {
    store = {}
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() { return Object.keys(store).length },
        key: (i: number) => Object.keys(store)[i] ?? null,
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = v },
        removeItem: (k: string) => { delete store[k] },
        clear: () => { store = {} },
      },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it("removes every chain slot and leaves unrelated keys alone", async () => {
    const { clearAllOwnerKeys } = await import("@/lib/owner-key")
    setOwnerKeyForChain("flow", FLOW)
    setOwnerKeyForChain("solana", MINT)
    store["rpc_theme"] = "light"
    store["rpc_owned_0xaaa"] = "[]"

    clearAllOwnerKeys()

    expect(getOwnerKeyForChain("flow")).toBe("")
    expect(getOwnerKeyForChain("solana")).toBe("")
    // ⚠ No-change control: without it, "clear everything" passes the two arms
    // above and silently signs the collector out of their theme and caches too.
    expect(store["rpc_theme"]).toBe("light")
    expect(store["rpc_owned_0xaaa"]).toBe("[]")
  })
})
