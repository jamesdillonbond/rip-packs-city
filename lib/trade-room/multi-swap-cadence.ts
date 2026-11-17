// lib/trade-room/multi-swap-cadence.ts
//
// The MULTI-COLLECTION trade-room swap (2026-11-02, Trevor: "go ahead and start" All Day /
// Golazos signing). Same shape as the proven Top Shot swap (lib/swap-test/swap-cadence.ts,
// sealed twice on mainnet 2026-10-31): ONE transaction, TWO authorizers, all or nothing —
// side A's moments go to side B's account and B's to A's. No escrow, no custody, no fee.
//
// What is new: each side gives moments from several collections at once (Top Shot, All Day, Golazos and, since the same afternoon, UFC Strike). The
// collection list is FIXED (SWAP_COLLECTIONS, in this order), so there is exactly ONE
// multi-collection transaction text for every trade, and a wallet co-signs only that text.
// Per side the arguments are one controller id and one id list PER COLLECTION, positional:
//   ctlsA[i] / idsA[i] belong to SWAP_COLLECTIONS[i].
// An all-Top-Shot room keeps the original SWAP_CADENCE (the proven text) — see
// lib/trade-room/execute.ts.
//
// Verified 2026-11-02 against the DEPLOYED mainnet contracts (Flow REST
// /v1/accounts/<addr>?expand=contracts): AllDay 0xe4cf4bdc1751c65d and Golazos
// 0x87ca73a41bb50ad5 store their collections at /storage/AllDayNFTCollection and
// /storage/GolazosNFTCollection, publish at the matching /public/ paths, and expose
// `access(NonFungibleToken.Withdraw) fun withdraw(withdrawID:)` + `deposit(token:)` with a
// `@AllDay.NFT` / `@Golazos.NFT` type check — no locking contract (Top Shot's
// TopShotLocking is enforced inside TopShot's own withdraw). Top Shot as in swap-cadence.ts.
// The simulation below was run on mainnet with real linked Dapper accounts before shipping
// (ledger 2026-11-02).
//
// ⭐ MULTI_SWAP_CADENCE and MULTI_SWAP_SIMULATION_SCRIPT are built from the SAME fragments
// (pinned by __tests__/trade-room-multi-swap.test.ts), so the server's simulation runs
// exactly the legs the wallets are asked to sign.

export interface SwapCollection {
  /** RPC's collection slug (lib/trade-block/rules.ts). */
  slug: "nba-top-shot" | "nfl-all-day" | "laliga-golazos" | "ufc"
  /** collections.slug (long form) — trade_room_items.collection / trade_rooms.collection. */
  dbSlug: "nba_top_shot" | "nfl_all_day" | "laliga_golazos" | "ufc_strike"
  /** collections.id — wallet_moments_cache is scoped by it (moment ids collide across collections). */
  collectionId: string
  label: string
  /** Short name for lists ("All Day 6605811"). */
  short: string
  contract: "TopShot" | "AllDay" | "Golazos" | "UFC_NFT"
  address: string
  storage: string
  public: string
}

export const SWAP_COLLECTIONS: readonly SwapCollection[] = [
  {
    slug: "nba-top-shot",
    dbSlug: "nba_top_shot",
    collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    label: "NBA Top Shot",
    short: "Top Shot",
    contract: "TopShot",
    address: "0x0b2a3299cc857e29",
    storage: "/storage/MomentCollection",
    public: "/public/MomentCollection",
  },
  {
    slug: "nfl-all-day",
    dbSlug: "nfl_all_day",
    collectionId: "dee28451-5d62-409e-a1ad-a83f763ac070",
    label: "NFL All Day",
    short: "All Day",
    contract: "AllDay",
    address: "0xe4cf4bdc1751c65d",
    storage: "/storage/AllDayNFTCollection",
    public: "/public/AllDayNFTCollection",
  },
  {
    slug: "laliga-golazos",
    dbSlug: "laliga_golazos",
    collectionId: "06248cc4-b85f-47cd-af67-1855d14acd75",
    label: "LaLiga Golazos",
    short: "Golazos",
    contract: "Golazos",
    address: "0x87ca73a41bb50ad5",
    storage: "/storage/GolazosNFTCollection",
    public: "/public/GolazosNFTCollection",
  },
  // 2026-11-02 (Trevor: "Yes do it"): UFC Strike. Deployed UFC_NFT at 0x329feb3ab062d289 read
  // via Flow REST: /storage/UFC_NFTCollection, /public/UFC_NFTCollection, a plain
  // `access(NonFungibleToken.Withdraw) fun withdraw` (no locking, no maturity); Dapper's
  // filter exposes its withdraw capability to a Flow Wallet parent (probed on two linked
  // accounts). Its Flow MARKET is closed — transfers are not.
  {
    slug: "ufc",
    dbSlug: "ufc_strike",
    collectionId: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
    label: "UFC Strike",
    short: "UFC",
    contract: "UFC_NFT",
    address: "0x329feb3ab062d289",
    storage: "/storage/UFC_NFTCollection",
    public: "/public/UFC_NFTCollection",
  },
] as const

export type SwapSlug = SwapCollection["slug"]

export function swapCollection(slug: string): SwapCollection | null {
  return SWAP_COLLECTIONS.find((c) => c.slug === slug) ?? null
}

export function swapCollectionByDbSlug(dbSlug: string): SwapCollection | null {
  return SWAP_COLLECTIONS.find((c) => c.dbSlug === dbSlug) ?? null
}

export function swapCollectionById(collectionId: string): SwapCollection | null {
  return SWAP_COLLECTIONS.find((c) => c.collectionId === collectionId) ?? null
}

/** At most this many moments per side, across all collections (same cap as the Top Shot swap). */
export const MAX_MULTI_SIDE = 10
export const MULTI_SWAP_GAS_LIMIT = 9999
const N = SWAP_COLLECTIONS.length

const IMPORTS = `import HybridCustody from 0xd8a7e05a7ac670c0
import NonFungibleToken from 0x1d7e57aa55817448
${SWAP_COLLECTIONS.map((c) => `import ${c.contract} from ${c.address}`).join("\n")}`

const PARAMS = "sourceA: Address, ctlsA: [UInt64], idsA: [[UInt64]], sourceB: Address, ctlsB: [UInt64], idsB: [[UInt64]]"

const SHAPE = `
        assert(ctlsA.length == ${N} && idsA.length == ${N} && ctlsB.length == ${N} && idsB.length == ${N}, message: "one controller and one id list per collection")
        var countA = 0
        var countB = 0
        for l in idsA { countA = countA + l.length }
        for l in idsB { countB = countB + l.length }
        assert(countA <= ${MAX_MULTI_SIDE} && countB <= ${MAX_MULTI_SIDE}, message: "a side gives at most ${MAX_MULTI_SIDE} moments")
        assert(countA + countB > 0, message: "nothing to swap")
        assert(sourceA != sourceB, message: "both sides draw from the same account")`

/** Binds `p<S><i>` — side S's withdraw reference for collection i, nil when it gives none there. */
function borrowOne(signer: string, s: "A" | "B", i: number): string {
  const c = SWAP_COLLECTIONS[i]
  return `
        var p${s}${i}: auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}? = nil
        if ids${s}[${i}].length > 0 {
            if source${s} == ${signer}.address {
                p${s}${i} = ${signer}.storage
                    .borrow<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>(from: ${c.storage})
                    ?? panic("Side ${s}: the signing wallet has no ${c.label} collection")
            } else {
                let manager = ${signer}.storage
                    .borrow<auth(HybridCustody.Manage) &HybridCustody.Manager>(from: HybridCustody.ManagerStoragePath)
                    ?? panic("Side ${s}: the signing wallet has no HybridCustody Manager (no linked accounts)")
                let child = manager.borrowAccount(addr: source${s})
                    ?? panic("Side ${s}: the signing wallet is not a parent of ".concat(source${s}.toString()))
                let cap = child.getCapability(
                    controllerID: ctls${s}[${i}],
                    type: Type<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>()
                ) ?? panic("Side ${s}: ${c.label} withdraw capability unavailable (Dapper's filter, or a stale controller id)")
                p${s}${i} = (cap as! Capability<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>).borrow()
                    ?? panic("Side ${s}: could not borrow the linked account's ${c.label} collection")
            }
        }`
}

/** Moves side S's ids of collection i from `ref` into side `to`'s source account. */
function moveOne(s: "A" | "B", to: "A" | "B", i: number, ref: string): string {
  const c = SWAP_COLLECTIONS[i]
  return `
        if ids${s}[${i}].length > 0 {
            let r = getAccount(source${to}).capabilities
                .borrow<&{NonFungibleToken.Receiver}>(${c.public})
                ?? panic("Side ${to}'s account has no ${c.label} collection to receive into")
            for id in ids${s}[${i}] {
                let nft <- ${ref}!.withdraw(withdrawID: id)
                assert(nft.getType() == Type<@${c.contract}.NFT>(), message: "Withdrawn NFT is not a ${c.label} moment")
                r.deposit(token: <-nft)
            }
        }`
}

const range = Array.from({ length: N }, (_, i) => i)
const borrowAll = (signer: string, s: "A" | "B") => range.map((i) => borrowOne(signer, s, i)).join("")

export const MULTI_SWAP_CADENCE = `${IMPORTS}

transaction(${PARAMS}) {
${range.map((i) => `    let pA${i}: auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}?\n    let pB${i}: auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}?`).join("\n")}

    prepare(a: auth(BorrowValue) &Account, b: auth(BorrowValue) &Account) {${SHAPE}${borrowAll("a", "A")}${borrowAll("b", "B")}
${range.map((i) => `        self.pA${i} = pA${i}\n        self.pB${i} = pB${i}`).join("\n")}
    }

    execute {${range.map((i) => moveOne("A", "B", i, `self.pA${i}`)).join("")}${range.map((i) => moveOne("B", "A", i, `self.pB${i}`)).join("")}
    }
}
`

/**
 * The same swap run as a script from both signers' accounts: every leg executes against
 * current mainnet state and nothing persists. Returns, in order (A's lists then B's, each
 * in collection order), whether each moment sits in the OTHER side's account afterwards.
 */
export const MULTI_SWAP_SIMULATION_SCRIPT = `${IMPORTS}

access(all) fun main(signerA: Address, signerB: Address, ${PARAMS}): [Bool] {
        let a = getAuthAccount<auth(BorrowValue) &Account>(signerA)
        let b = getAuthAccount<auth(BorrowValue) &Account>(signerB)${SHAPE}${borrowAll("a", "A")}${borrowAll("b", "B")}
${range.map((i) => moveOne("A", "B", i, `pA${i}`)).join("")}${range.map((i) => moveOne("B", "A", i, `pB${i}`)).join("")}
        let paths: [PublicPath] = [${SWAP_COLLECTIONS.map((c) => c.public).join(", ")}]
        let out: [Bool] = []
        var i = 0
        while i < ${N} {
            for id in idsA[i] { out.append(holds(sourceB, paths[i], id)) }
            i = i + 1
        }
        i = 0
        while i < ${N} {
            for id in idsB[i] { out.append(holds(sourceA, paths[i], id)) }
            i = i + 1
        }
        return out
}

access(all) fun holds(_ a: Address, _ path: PublicPath, _ id: UInt64): Bool {
    let col = getAccount(a).capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(path)
    return col != nil && col!.borrowNFT(id) != nil
}
`

/**
 * Controller ids on `child` whose capability `parent` (a HybridCustody manager) may use to
 * withdraw from the collection stored at `storage` — PROVIDER_CONTROLLERS_SCRIPT
 * (lib/giveaways/deliver-cadence.ts) generalised over the storage path. Empty = the parent
 * cannot withdraw that collection (not a parent, or Dapper's filter blocks it).
 */
export function controllersScript(storage: string): string {
  return `import HybridCustody from 0xd8a7e05a7ac670c0
import NonFungibleToken from 0x1d7e57aa55817448

access(all) fun main(parent: Address, child: Address): [UInt64] {
    let out: [UInt64] = []
    let p = getAuthAccount<auth(Storage) &Account>(parent)
    let m = p.storage.borrow<auth(HybridCustody.Manage) &HybridCustody.Manager>(from: HybridCustody.ManagerStoragePath)
    if m == nil {
        return out
    }
    let acct = m!.borrowAccount(addr: child)
    if acct == nil {
        return out
    }
    let c = getAuthAccount<auth(Capabilities) &Account>(child)
    for ctl in c.capabilities.storage.getControllers(forPath: ${storage}) {
        if ctl.capability.check<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>() {
            let cap = acct!.getCapability(controllerID: ctl.capabilityID, type: Type<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>())
            if cap != nil {
                out.append(ctl.capabilityID)
            }
        }
    }
    return out
}
`
}

/** Whether each address can RECEIVE each collection (a published Receiver at its public path). */
export const CAN_RECEIVE_SCRIPT = `import NonFungibleToken from 0x1d7e57aa55817448

access(all) fun main(addr: Address): [Bool] {
    let paths: [PublicPath] = [${SWAP_COLLECTIONS.map((c) => c.public).join(", ")}]
    let out: [Bool] = []
    for p in paths {
        out.append(getAccount(addr).capabilities.borrow<&{NonFungibleToken.Receiver}>(p) != nil)
    }
    return out
}
`

/**
 * Every id `addr` holds of one collection (its public collection's getIDs), or nil when the
 * account has no such collection — i.e. exactly what a swap can withdraw. The picker for All
 * Day / Golazos / UFC starts from THIS, not from RPC's index: on 2026-11-02 RPC listed 3,723
 * All Day Moments for an account whose on-chain collection held 40, because RPC's holdings
 * also count Moments that are LOCKED (All Day's locker) or held by Dapper's studio (known
 * issue #191) — owned, but not in the collection, so not tradeable.
 */
export function idsScript(slug: Exclude<SwapSlug, "nba-top-shot">): string {
  const c = swapCollection(slug)!
  return `import NonFungibleToken from 0x1d7e57aa55817448

access(all) fun main(addr: Address): [UInt64]? {
    if let col = getAccount(addr).capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(${c.public}) {
        return col.getIDs()
    }
    return nil
}
`
}

/**
 * Held-ness of All Day / Golazos / UFC Strike ids at an address (no locking exists for any of them). Returns the
 * ids it holds; ids it does not hold are absent.
 */
export function heldScript(slug: Exclude<SwapSlug, "nba-top-shot">): string {
  const c = swapCollection(slug)!
  return `import NonFungibleToken from 0x1d7e57aa55817448
import ${c.contract} from ${c.address}

access(all) fun main(addr: Address, ids: [UInt64]): [UInt64] {
    let out: [UInt64] = []
    let col = getAccount(addr).capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(${c.public})
    if col == nil {
        return out
    }
    for id in ids {
        if let nft = col!.borrowNFT(id) {
            if nft.getType() == Type<@${c.contract}.NFT>() {
                out.append(id)
            }
        }
    }
    return out
}
`
}
