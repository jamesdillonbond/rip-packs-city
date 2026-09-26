import { readFileSync } from "node:fs"
import { join } from "node:path"
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
    // Candy's partner label is "candy" but it dispatches as Solana.
    expect(getCollection("candy-mlb")?.dbChain).toBe("solana")
    // RE-PINNED 2026-09-20: Panini was "ethereum", naming the OpenSea bridge.
    // #64 made the WC Prizm plane the collection and RPC holds zero bridge rows,
    // so the authoritative answer is "not established" — same value as RWA, and
    // for the same reason. See lib/collections.ts for the measured consequence.
    expect(getCollection("panini-blockchain")?.dbChain).toBeNull()
    // RWA has no seeded DB row yet, so no authoritative chain.
    expect(getCollection("rwa")?.dbChain).toBeNull()
  })

  // REWRITTEN 2026-09-06: this guard used to pin "every published collection is
  // Flow". Candy MLB (Solana) is published now — deliberately, Trevor's
  // delegated decision — so the invariant that still holds is narrower and
  // load-bearing: a NON-Flow published collection may expose ONLY the pages that
  // have a dispatch for ITS chain. Adding a tab without one renders a
  // Flow-shaped page for a Solana wallet.
  //
  // ⭐ REWRITTEN AGAIN 2026-09-12, and the shape of the rewrite is the point.
  // The old form asserted `pages` equals `["overview"]` — a hardcoded answer, so
  // the only way to add a legitimate tab was to edit the expected value, which
  // is indistinguishable from editing it to smuggle a tab through. It taught the
  // next person that this guard is something you update, not something you
  // satisfy. It now names the (chain, page) pairs that HAVE a dispatch, so
  // widening it is a deliberate, reviewable claim about code that exists — and
  // the next test makes that claim FALSIFIABLE rather than clerical.
  const DISPATCHED: Record<string, string[]> = {
    // `overview` is chain-agnostic (it reads collection-level aggregates).
    // `market` gained its Solana arm on 2026-09-12: /api/market dispatches
    // Candy's collection id to fetchCandyMarketListings → candy_market_board,
    // 1,821 active listings, all with price + serial + FMV + thumbnail.
    //
    // ⭐ `collection` joined on 2026-09-19 ON A DIFFERENT BASIS FROM `market`,
    // and the difference is the whole finding. `market` needed an ARM written.
    // `collection` did not: a route-by-route sweep of every endpoint
    // CollectionTabClient calls found the data path already chain-agnostic, and
    // what blocked it were Flow-shaped GATES in front of it — `startsWith("0x")`,
    // `.toLowerCase()` on a CASE-SENSITIVE base58 key, a `contractName`
    // short-circuit. So the dispatch being asserted here is the ABSENCE of those
    // gates, and the test below pins exactly that, behaviourally.
    //
    // ⭐ `analytics` joined 2026-09-20, on the `collection` basis (gates, not an
    // arm) PLUS one genuine data gap that had to be closed first, and the test
    // below pins both halves. Every panel on the tab was read against Candy live
    // before this line was widened — see the registry comment on candy-mlb for
    // the per-panel numbers.
    //
    // ⭐ `sets` joined 2026-09-25 on the `market` basis — an ARM written:
    // /api/candy-set-progress, because the generic /api/sets-db folds the
    // wallet and counts editions (not players) as slots. The test below pins
    // that the client dispatches Candy there and the route keeps the key intact.
    solana: ["overview", "market", "collection", "sets", "analytics"],
    ethereum: ["overview"],
  }

  it("every published NON-Flow collection exposes only pages that have a dispatch for its chain", () => {
    const nonFlow = COLLECTIONS.filter((c) => c.published && c.dbChain !== "flow")
    expect(nonFlow.map((c) => c.id)).toEqual(["candy-mlb"])
    for (const c of nonFlow) {
      const allowed = DISPATCHED[c.dbChain ?? ""] ?? []
      for (const page of c.pages) {
        expect(
          allowed.includes(page),
          `${c.id} exposes "${page}" with no ${c.dbChain} dispatch — add the arm before the tab`,
        ).toBe(true)
      }
    }
  })

  // ⚠ THE HALF THAT MAKES THE LIST ABOVE MEAN SOMETHING. Without this, a future
  // session can add "sniper" to DISPATCHED[solana], get green, and ship a Flow
  // page to a Solana collection — the allow-list would just be the assertion
  // restating itself. Pinned as a SOURCE fact because there is no route-level
  // harness here and the failure is silent: a Flow-dispatched page pointed at a
  // Solana collection renders an empty board, not an error.
  it("⚠ the Solana `market` permission is backed by an actual arm in /api/market", () => {
    const route = readFileSync(join(process.cwd(), "app/api/market/route.ts"), "utf8")
    expect(route).toContain("fetchCandyMarketListings")
    expect(route).toContain("candy_market_board")
    // Candy's collection id must be a dispatch branch, not just a mention.
    expect(route).toContain("CANDY_COLLECTION_ID_FOR_DISPATCH")
    expect(route).toContain("209ade70-32c5-4470-bc7c-4793d660f713")
  })
  // ⚠ THE BACKING HALF FOR `sets`. The Set Tracker client dispatches per
  // collection; without a Candy arm it falls through to /api/sets-db, which
  // lowercases the wallet (a base58 key then matches nothing → "0 of 100").
  it("⚠ the Solana `sets` permission is backed by a Candy arm that keeps the key verbatim", () => {
    const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")
    const client = read("app/(collections)/[collection]/sets/CollectionSetsClient.tsx")
    expect(client).toContain('collectionSlug === "candy-mlb"')
    expect(client).toContain('isCandy ? "/api/candy-set-progress"')
    const route = read("app/api/candy-set-progress/route.ts")
    expect(route).toContain("isSolanaAddress(raw)")
    expect(route).toContain("const wallet = raw\n")
    expect(route).not.toMatch(/raw\.toLowerCase\(\)|normalizeAddress\(/)
    expect(route).toContain("209ade70-32c5-4470-bc7c-4793d660f713")
  })

  // ⚠ THE OTHER HALF, for `collection`. It cannot be the same SHAPE of check as
  // the `market` one above, because there is no Candy-specific function to name
  // — that is the point: the Collection tab works for Solana precisely because
  // nothing on its path is chain-specific any more. So this pins the two things
  // that make "chain-agnostic" TRUE rather than merely claimed: the address
  // helpers behave correctly for base58 (called, not grepped), and the routes the
  // tab calls are keyed on those helpers instead of a Flow shape.
  it("⚠ the Solana `collection` permission is backed by chain-aware address handling, not a Flow gate", async () => {
    const { isSupportedAddress, normalizeAddress, detectAddressChain } = await import("@/lib/address")
    const MINT = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"

    expect(detectAddressChain(MINT)).toBe("solana")
    expect(isSupportedAddress(MINT)).toBe(true)
    // ⛔ THE DEFECT THIS REPLACED: base58 is CASE-SENSITIVE, so the Flow habit
    // of folding a wallet to lowercase does not normalise a Solana key, it
    // DESTROYS it — and the read then returns zero rows, which reads as "this
    // wallet holds nothing" rather than as an error.
    expect(normalizeAddress(MINT)).toBe(MINT)
    // No-change control: Flow/EVM addresses must still fold, or every Flow
    // caller regresses while this test stays green.
    expect(normalizeAddress("0xAABBCCDDEEFF0011")).toBe("0xaabbccddeeff0011")
    // …and a username is still not an address, so widening the gate did not
    // turn a Panini handle into a wallet.
    expect(isSupportedAddress("trevor")).toBe(false)

    const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")
    // The three reads behind the tab's moment grid and counts.
    expect(read("app/api/collection-moments/route.ts")).toContain("isSupportedAddress")
    expect(read("app/api/wallet/edition-counts/route.ts")).toContain("normalizeAddress(wallet)")
    expect(read("app/api/wallet-summary/route.ts")).toContain("isSupportedAddress")
    // ⚠ And the two panels that genuinely CANNOT answer for Solana say so in a
    // typed field. This is the line that keeps the tab honest: absence, never a
    // fabricated zero. Deleting either reason string should fail here.
    expect(read("app/api/sets/route.ts")).toContain("set_tracking_unavailable")
    expect(read("app/api/cost-basis/route.ts")).toContain("cost_basis_unavailable")
  })

  // ⚠ THE BACKING HALF FOR `analytics`. Two independent failures had to be fixed
  // before the tab could be honest, and BOTH failed SILENTLY — an empty card, not
  // an error — so neither a route test nor a 200 check could have caught them.
  // This pins each one at the layer it lives in, and pins the no-change arm that
  // makes the first assertion non-vacuous.
  it("⚠ the Solana `analytics` permission is backed by a real key derivation and a real listings source", async () => {
    const { shortSlug } = await import("@/lib/analytics/format")

    // (1) THE KEY. Every card on the tab queries /api/analytics/* with
    // shortSlug(urlSlug). The analytics_* RPCs normalize with
    // `CASE … ELSE c.slug`, so Candy's key is the UNDERSCORE slug. Returning the
    // hyphen slug (the old five-entry hardcoded map's fall-through) matches zero
    // rows in every one of them, and each card renders that as its EMPTY state.
    expect(shortSlug("candy-mlb")).toBe("candy_mlb")
    // ⛔ NO-CHANGE CONTROL — without this, deriving the key could have rewritten
    // the five Flow collections' keys and this test would still be green.
    expect(shortSlug("nba-top-shot")).toBe("topshot")
    expect(shortSlug("nfl-all-day")).toBe("allday")
    expect(shortSlug("laliga-golazos")).toBe("golazos")
    expect(shortSlug("disney-pinnacle")).toBe("pinnacle")
    expect(shortSlug("ufc")).toBe("ufc")

    // (2) THE LISTINGS SOURCE. Candy has ZERO rows in `cached_listings` — its
    // asks are indexed into `candy_listings` — so `analytics_listings_summary`
    // returned an empty order book for it, which the Order Book Depth card
    // renders as the literal words "No live listings." about ~1,900 live asks.
    // Pinned as a SOURCE fact on the migration, because the function body is the
    // only place the arm exists and there is no local harness for it here.
    const { readdirSync } = await import("node:fs")
    const migDir = join(process.cwd(), "supabase/migrations")
    const candyArm = readdirSync(migDir).find((f) =>
      f.includes("candy_arm_for_analytics_listings_summary"),
    )
    expect(candyArm, "the migration adding the Candy arm to analytics_listings_summary is missing").toBeTruthy()
    const sql = readFileSync(join(migDir, candyArm as string), "utf8")
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.analytics_listings_summary")
    expect(sql).toContain("FROM candy_listings l")
    expect(sql).toContain("candy_fmv_current")
    // ⛔ The arm must not emit a row when Candy is filtered OUT: a zero-count row
    // is the fabricated-value shape, and the card cannot tell it from real depth.
    expect(sql).toContain("HAVING COUNT(*) > 0")
    // The shared cached_listings arm must survive the rewrite untouched.
    expect(sql).toContain("FROM cached_listings cl")

    // (3) THE LABEL. The Candy row now reaches /analytics/listings too, and
    // resolveCollectionLabel falls back to the RAW SLUG.
    const { resolveCollectionLabel } = await import("@/lib/analytics-listings-compute")
    expect(resolveCollectionLabel("candy_mlb")).toBe("Candy MLB")
    expect(resolveCollectionLabel("topshot")).toBe("Top Shot")
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
