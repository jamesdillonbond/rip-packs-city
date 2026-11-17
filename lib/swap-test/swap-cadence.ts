// lib/swap-test/swap-cadence.ts
//
// The admin-only TWO-SIGNER SWAP TEST (Trevor, 2026-10-03: "Do it all", approving
// docs/strategy/trading-revisit-2026-10-03.md §6). One transaction, two
// authorizers: side A's moments go to side B's account and B's to A's, all or
// nothing. No escrow, no custody: RPC builds the transaction, the two wallets
// sign it, RPC holds no key and pays no fee.
//
// A side's SOURCE is where its moments sit: the signing Flow Wallet itself
// ("own" — it borrows its own collection) or a Hybrid Custody child it has
// redeemed, e.g. a Dapper account ("linked" — it withdraws through the child's
// capability, controller id from PROVIDER_CONTROLLERS_SCRIPT). A side may give
// nothing (empty id list) and still sign; that is how the first run moves one
// moment into an empty wallet so a later run can swap both ways.
//
// ⭐ SWAP_CADENCE and SWAP_SIMULATION_SCRIPT are built from the SAME fragments
// (pinned by __tests__/swap-test-cadence.test.ts), so the server's simulation
// runs exactly the legs the wallets are asked to sign.

export const MAX_SWAP_SIDE = 10
export const SWAP_GAS_LIMIT = 9999

const IMPORTS = `import HybridCustody from 0xd8a7e05a7ac670c0
import NonFungibleToken from 0x1d7e57aa55817448
import TopShot from 0x0b2a3299cc857e29`

/**
 * Binds `provider<S>` (optional; nil when the side gives nothing) from `signer`,
 * an `auth(BorrowValue) &Account`, for side S ("A" or "B").
 */
export function borrowSide(signer: string, s: "A" | "B"): string {
  return `
        assert(ids${s}.length <= ${MAX_SWAP_SIDE}, message: "a side gives at most ${MAX_SWAP_SIDE} moments")
        var provider${s}: auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}? = nil
        if ids${s}.length > 0 {
            if source${s} == ${signer}.address {
                provider${s} = ${signer}.storage
                    .borrow<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>(from: /storage/MomentCollection)
                    ?? panic("Side ${s}: the signing wallet has no Top Shot collection")
            } else {
                let manager${s} = ${signer}.storage
                    .borrow<auth(HybridCustody.Manage) &HybridCustody.Manager>(from: HybridCustody.ManagerStoragePath)
                    ?? panic("Side ${s}: the signing wallet has no HybridCustody Manager (no linked accounts)")
                let child${s} = manager${s}.borrowAccount(addr: source${s})
                    ?? panic("Side ${s}: the signing wallet is not a parent of ".concat(source${s}.toString()))
                let cap${s} = child${s}.getCapability(
                    controllerID: ctl${s},
                    type: Type<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>()
                ) ?? panic("Side ${s}: withdraw capability unavailable (Dapper's filter, or a stale controller id)")
                provider${s} = (cap${s} as! Capability<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>).borrow()
                    ?? panic("Side ${s}: could not borrow the linked account's Top Shot collection")
            }
        }`
}

/** Moves every id of side S out of `providerRef` into side `to`'s source account. */
export function moveSide(s: "A" | "B", to: "A" | "B", providerRef: string): string {
  return `
        if ids${s}.length > 0 {
            let receiver${s} = getAccount(source${to}).capabilities
                .borrow<&{NonFungibleToken.Receiver}>(/public/MomentCollection)
                ?? panic("Side ${to}'s account has no Top Shot collection to receive into")
            for id in ids${s} {
                let moment <- ${providerRef}!.withdraw(withdrawID: id)
                assert(moment.getType() == Type<@TopShot.NFT>(), message: "Withdrawn NFT is not a Top Shot moment")
                receiver${s}.deposit(token: <-moment)
            }
        }`
}

const BOTH_SIDES_GIVE_SOMETHING = `
        assert(idsA.length + idsB.length > 0, message: "nothing to swap")
        assert(sourceA != sourceB, message: "both sides draw from the same account")`

const PARAMS = "sourceA: Address, ctlA: UInt64, idsA: [UInt64], sourceB: Address, ctlB: UInt64, idsB: [UInt64]"

export const SWAP_CADENCE = `${IMPORTS}

transaction(${PARAMS}) {
    let pA: auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}?
    let pB: auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}?

    prepare(a: auth(BorrowValue) &Account, b: auth(BorrowValue) &Account) {${BOTH_SIDES_GIVE_SOMETHING}${borrowSide("a", "A")}${borrowSide("b", "B")}
        self.pA = providerA
        self.pB = providerB
    }

    execute {${moveSide("A", "B", "self.pA")}${moveSide("B", "A", "self.pB")}
    }
}
`

/**
 * The same swap run as a script from both signers' accounts: every leg executes
 * against current mainnet state and nothing persists. Returns, in order (A's ids
 * then B's), whether each moment sits in the OTHER side's account afterwards.
 */
export const SWAP_SIMULATION_SCRIPT = `${IMPORTS}

access(all) fun main(signerA: Address, signerB: Address, ${PARAMS}): [Bool] {
        let a = getAuthAccount<auth(BorrowValue) &Account>(signerA)
        let b = getAuthAccount<auth(BorrowValue) &Account>(signerB)${BOTH_SIDES_GIVE_SOMETHING}${borrowSide("a", "A")}${borrowSide("b", "B")}
${moveSide("A", "B", "providerA")}${moveSide("B", "A", "providerB")}
        let out: [Bool] = []
        for id in idsA { out.append(holds(sourceB, id)) }
        for id in idsB { out.append(holds(sourceA, id)) }
        return out
}

access(all) fun holds(_ a: Address, _ id: UInt64): Bool {
    let col = getAccount(a).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
    return col != nil && col!.borrowMoment(id: id) != nil
}
`
