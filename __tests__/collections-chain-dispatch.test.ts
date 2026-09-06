import { describe, it, expect } from "vitest"
import {
  COLLECTIONS,
  marketplaceMomentUrl,
  marketplaceWalletUrl,
  dapperMarketMomentUrl,
  dapperMarketPacksBrowseUrl,
  getCollection,
  getCollectionUuid,
  toDbSlug,
  fromDbSlug,
  type ChainType,
} from "@/lib/collections"

// Chain-DISPATCH coverage — the surfaces that must branch on chain as chain two
// (Candy MLB / Solana) and the Panini Ethereum bridge come online. collections-
// urls.test.ts already pins the Flow collections' outbound links; this file
// exists for the non-Flow cases and, above all, the FALL-THROUGH guards: a
// Solana mint id or an Ethereum token must NEVER be handed to a Flow-only URL
// builder (dapper.market), which would silently render a link to the wrong
// chain's marketplace. The Phase-E audit flagged these builders as the code
// surfaces that "assume Flow"; this is their regression net.

const VALID_CHAIN_TYPES: ReadonlySet<ChainType> = new Set<ChainType>([
  "flow",
  "ethereum",
  "polygon",
  "solana",
  "flow_evm",
])

describe("dbChain registry invariant", () => {
  it("every collection's dbChain is a valid chain_type enum value or null", () => {
    for (const c of COLLECTIONS) {
      if (c.dbChain === null || c.dbChain === undefined) continue
      expect(
        VALID_CHAIN_TYPES.has(c.dbChain),
        `${c.id} has dbChain=${c.dbChain}, not a member of the Postgres chain_type enum`,
      ).toBe(true)
    }
  })

  it("pins the authoritative dispatch chain for the non-Flow collections", () => {
    // These are the roadmap/label `chain` vs the DB dispatch `dbChain` split —
    // Candy's partner label is "candy" but it dispatches as Solana; Panini's is
    // "panini" but it dispatches as its Ethereum/OpenSea bridge.
    expect(getCollection("candy-mlb")?.dbChain).toBe("solana")
    expect(getCollection("panini-blockchain")?.dbChain).toBe("ethereum")
    // RWA has no seeded DB row yet, so no authoritative chain.
    expect(getCollection("rwa")?.dbChain).toBeNull()
  })

  // REWRITTEN 2026-09-06: this guard used to pin "every published collection is
  // Flow". Candy MLB (Solana) is published now — deliberately, Trevor's
  // delegated decision, thin (overview only) — so the invariant that still holds
  // is narrower and load-bearing: a NON-Flow published collection may expose
  // ONLY the pages that have a chain dispatch. Today that is `overview`; the
  // Collection / Packs / Sniper tabs are Flow-dispatched with zero Solana arms.
  // Adding a tab here without its dispatch would render a Flow page for a
  // Solana wallet — this test is what stops that.
  it("every published NON-Flow collection is thin — overview only, until its tabs have a chain dispatch", () => {
    const nonFlow = COLLECTIONS.filter((c) => c.published && c.dbChain !== "flow")
    expect(nonFlow.map((c) => c.id)).toEqual(["candy-mlb"])
    for (const c of nonFlow) {
      expect(c.pages, `${c.id} exposes a tab with no ${c.dbChain} dispatch`).toEqual(["overview"])
    }
  })
  it("every published FLOW collection still declares dbChain flow (the chain filters key on it)", () => {
    for (const c of COLLECTIONS) {
      if (!c.published || c.id === "candy-mlb") continue
      expect(c.dbChain, `published collection ${c.id} is not on Flow`).toBe("flow")
    }
  })
})

describe("marketplaceMomentUrl — chain-two dispatch", () => {
  it("routes a Candy MLB mint to Magic Eden (Solana), not a Flow marketplace", () => {
    const url = marketplaceMomentUrl("candy-mlb", "SoLMintAddr123")
    expect(url).toBe("https://magiceden.io/item-details/SoLMintAddr123")
    // A Solana mint must never leak a Flow marketplace host.
    expect(url).not.toMatch(/nbatopshot|nflallday|laligagolazos|disneypinnacle|dapper\.market/)
  })

  it("returns null for Panini (no per-asset moment template until the bridge contract is known)", () => {
    expect(marketplaceMomentUrl("panini-blockchain", "1")).toBeNull()
  })
})

describe("marketplaceWalletUrl — chain-two dispatch", () => {
  it("routes a Candy MLB wallet to a Magic Eden profile (Solana base58)", () => {
    expect(marketplaceWalletUrl("candy-mlb", "63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY")).toBe(
      "https://magiceden.io/u/63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY",
    )
  })

  it("routes a Panini wallet to an OpenSea profile (Ethereum)", () => {
    expect(marketplaceWalletUrl("panini-blockchain", "0xdeadbeef")).toBe(
      "https://opensea.io/0xdeadbeef",
    )
  })
})

describe("Flow-only dapper.market builders never accept a non-Flow collection", () => {
  // This is the load-bearing fall-through guard. dapper.market is a Flow
  // secondary marketplace; handing it a Solana mint or an Ethereum token would
  // build a plausible-looking URL to a listing that cannot exist. Both builders
  // are keyed by an explicit Flow-league allowlist, so the correct behaviour for
  // every non-Flow collection is null.
  it("dapperMarketMomentUrl returns null for Candy (Solana) and Panini (Ethereum)", () => {
    expect(dapperMarketMomentUrl("candy-mlb", "SoLMintAddr123")).toBeNull()
    expect(dapperMarketMomentUrl("panini-blockchain", "1")).toBeNull()
  })

  it("dapperMarketPacksBrowseUrl returns null for Candy and Panini", () => {
    expect(dapperMarketPacksBrowseUrl("candy-mlb")).toBeNull()
    expect(dapperMarketPacksBrowseUrl("panini-blockchain")).toBeNull()
  })

  it("INVARIANT: no collection whose dbChain is not 'flow' ever resolves to a dapper.market URL", () => {
    // Durable guard that also covers any FUTURE chain added to the registry —
    // if someone adds a `base` collection and forgets that dapper.market is
    // Flow-only, this fails rather than shipping a cross-chain 404.
    for (const c of COLLECTIONS) {
      if (c.dbChain === "flow") continue
      expect(
        dapperMarketMomentUrl(c.id, "123"),
        `${c.id} (dbChain=${c.dbChain}) leaked a Flow dapper.market moment URL`,
      ).toBeNull()
      expect(
        dapperMarketPacksBrowseUrl(c.id),
        `${c.id} (dbChain=${c.dbChain}) leaked a Flow dapper.market packs URL`,
      ).toBeNull()
    }
  })
})

describe("slug↔db-slug↔uuid bridge resolves the seeded chain-two collections pre-publish", () => {
  // candy-mlb / panini-blockchain are unpublished but seeded, and routes resolve
  // the bridge before publish — so the mapping must round-trip even while
  // published:false, or a chain-two route 500s on lookup the day it goes live.
  it("candy-mlb round-trips slug → db-slug → slug and has a UUID", () => {
    expect(toDbSlug("candy-mlb")).toBe("candy_mlb")
    expect(fromDbSlug("candy_mlb")).toBe("candy-mlb")
    expect(getCollectionUuid("candy-mlb")).toBe("209ade70-32c5-4470-bc7c-4793d660f713")
  })

  it("panini-blockchain round-trips slug → db-slug → slug and has a UUID", () => {
    expect(toDbSlug("panini-blockchain")).toBe("panini_blockchain")
    expect(fromDbSlug("panini_blockchain")).toBe("panini-blockchain")
    expect(getCollectionUuid("panini-blockchain")).toBe("d1a0a7f5-609a-49f4-a1a7-4eaac55b020b")
  })

  it("returns null for an unknown slug rather than guessing", () => {
    expect(toDbSlug("not-a-collection")).toBeNull()
    expect(fromDbSlug("not_a_collection")).toBeNull()
    expect(getCollectionUuid("not-a-collection")).toBeNull()
  })
})
