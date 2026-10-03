// lib/giveaways/deliver-cadence.ts
//
// "Deliver all": ONE transaction, signed by the admin's own Flow Wallet (a
// Hybrid Custody PARENT of their Dapper account), that moves every claimed
// Moment straight from the Dapper account to its claimer. RPC never signs,
// holds a key, or holds a Moment — it builds this and the admin approves it.
// (Trevor, 2026-09-29: "Yes do that" — option A, the narrow read-only exception.)
//
// The legs are the ones verified for GIFT_MOMENT_CADENCE
// (lib/chains/flow/cadence/gift-moment.ts; docs/design/parent-signed-gifting-fcl-flow-2026-07-13.md)
// and re-verified on 2026-09-29 against Trevor's own link: both parents of
// 0xbd94cade097e50ac resolve Top Shot withdraw capabilities.
//
// ⭐ The transaction and DELIVER_SIMULATION_SCRIPT are built from the SAME
// Cadence fragments. A script may run the whole withdraw → deposit in memory
// (a script's state changes are discarded), so the server simulates the exact
// batch against live mainnet state before the admin is asked to sign, and
// __tests__/giveaways-deliver-cadence.test.ts pins that the two share their
// statements. A panic the admin would hit at signing surfaces at planning.

export const MAX_DELIVERY_BATCH = 50

const IMPORTS = `import HybridCustody from 0xd8a7e05a7ac670c0
import NonFungibleToken from 0x1d7e57aa55817448
import TopShot from 0x0b2a3299cc857e29`

// `parent` is an `auth(BorrowValue) &Account`; binds `provider`.
export const BORROW_PROVIDER = `
        assert(momentIDs.length == recipients.length, message: "momentIDs and recipients differ in length")
        assert(momentIDs.length > 0 && momentIDs.length <= ${MAX_DELIVERY_BATCH}, message: "a batch holds 1 to ${MAX_DELIVERY_BATCH} moments")
        let manager = parent.storage
            .borrow<auth(HybridCustody.Manage) &HybridCustody.Manager>(from: HybridCustody.ManagerStoragePath)
            ?? panic("The signing wallet has no HybridCustody Manager (no linked accounts)")
        let child = manager.borrowAccount(addr: childAddress)
            ?? panic("The signing wallet is not a parent of ".concat(childAddress.toString()))
        let cap = child.getCapability(
            controllerID: providerControllerID,
            type: Type<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>()
        ) ?? panic("Withdraw capability unavailable: Dapper's filter blocked it or the controller id is stale")
        let provider = (cap as! Capability<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>).borrow()
            ?? panic("Could not borrow the linked account's Top Shot collection")`

// Moves momentIDs[i] -> recipients[i] through `providerRef`.
export function deliverLoop(providerRef: string): string {
  return `
        var i = 0
        while i < momentIDs.length {
            let receiver = getAccount(recipients[i]).capabilities
                .borrow<&{NonFungibleToken.Receiver}>(/public/MomentCollection)
                ?? panic("Recipient ".concat(recipients[i].toString()).concat(" has no Top Shot collection"))
            let moment <- ${providerRef}.withdraw(withdrawID: momentIDs[i])
            assert(moment.getType() == Type<@TopShot.NFT>(), message: "Withdrawn NFT is not a Top Shot moment")
            receiver.deposit(token: <-moment)
            i = i + 1
        }`
}

export const DELIVER_BATCH_CADENCE = `${IMPORTS}

transaction(childAddress: Address, providerControllerID: UInt64, momentIDs: [UInt64], recipients: [Address]) {
    let provider: auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}

    prepare(parent: auth(BorrowValue) &Account) {${BORROW_PROVIDER}
        self.provider = provider
    }

    execute {${deliverLoop("self.provider")}
    }
}
`

/**
 * The same batch, run as a script from the parent's account: every leg executes
 * for real against current mainnet state, and nothing persists. Returns, per
 * moment, whether its recipient holds it after the (discarded) transfer.
 */
export const DELIVER_SIMULATION_SCRIPT = `${IMPORTS}

access(all) fun main(parentAddress: Address, childAddress: Address, providerControllerID: UInt64, momentIDs: [UInt64], recipients: [Address]): [Bool] {
        let parent = getAuthAccount<auth(BorrowValue) &Account>(parentAddress)${BORROW_PROVIDER}
${deliverLoop("provider")}
        let out: [Bool] = []
        var j = 0
        while j < momentIDs.length {
            let col = getAccount(recipients[j]).capabilities
                .borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
            out.append(col != nil && col!.borrowMoment(id: momentIDs[j]) != nil)
            j = j + 1
        }
        return out
}
`

// ── Moments in the signing wallet ITSELF (the sponsor's Flow Wallet) ──────────
// A pool can span the Flow Wallet and its linked accounts (2026-10-03). For the
// Flow Wallet's own moments there is no Hybrid Custody leg: the signer borrows
// its own collection. Same deliverLoop, same simulate-then-sign discipline.

// `owner` is an `auth(BorrowValue) &Account`; binds `provider`.
export const BORROW_OWN_PROVIDER = `
        assert(momentIDs.length == recipients.length, message: "momentIDs and recipients differ in length")
        assert(momentIDs.length > 0 && momentIDs.length <= ${MAX_DELIVERY_BATCH}, message: "a batch holds 1 to ${MAX_DELIVERY_BATCH} moments")
        let provider = owner.storage
            .borrow<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>(from: /storage/MomentCollection)
            ?? panic("The signing wallet has no Top Shot collection")`

export const DELIVER_OWN_BATCH_CADENCE = `${IMPORTS}

transaction(momentIDs: [UInt64], recipients: [Address]) {
    let provider: auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}

    prepare(owner: auth(BorrowValue) &Account) {${BORROW_OWN_PROVIDER}
        self.provider = provider
    }

    execute {${deliverLoop("self.provider")}
    }
}
`

export const DELIVER_OWN_SIMULATION_SCRIPT = `${IMPORTS}

access(all) fun main(ownerAddress: Address, momentIDs: [UInt64], recipients: [Address]): [Bool] {
        let owner = getAuthAccount<auth(BorrowValue) &Account>(ownerAddress)${BORROW_OWN_PROVIDER}
${deliverLoop("provider")}
        let out: [Bool] = []
        var j = 0
        while j < momentIDs.length {
            let col = getAccount(recipients[j]).capabilities
                .borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
            out.append(col != nil && col!.borrowMoment(id: momentIDs[j]) != nil)
            j = j + 1
        }
        return out
}
`

/**
 * The connected wallet and every account it has linked: the wallet's own Top
 * Shot count, then one entry per Hybrid Custody child it has REDEEMED (read
 * from the child's own OwnedAccount record — a merely offered link is excluded).
 * -1 = no Top Shot collection there. Read-only; verified on mainnet 2026-10-03
 * against Trevor's Flow Wallet (itself + 2 redeemed children) and a control
 * address (itself only).
 */
export const LINKED_ACCOUNTS_SCRIPT = `import HybridCustody from 0xd8a7e05a7ac670c0
import TopShot from 0x0b2a3299cc857e29

access(all) fun main(parent: Address): {Address: Int} {
    let out: {Address: Int} = {}
    out[parent] = topShotCount(parent)
    if let manager = getAccount(parent).capabilities.borrow<&{HybridCustody.ManagerPublic}>(HybridCustody.ManagerPublicPath) {
        for child in manager.getChildAddresses() {
            if let owned = getAccount(child).capabilities.borrow<&{HybridCustody.OwnedAccountPublic}>(HybridCustody.OwnedAccountPublicPath) {
                if owned.getRedeemedStatus(addr: parent) == true {
                    out[child] = topShotCount(child)
                }
            }
        }
    }
    return out
}

access(all) fun topShotCount(_ a: Address): Int {
    if let c = getAccount(a).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) {
        return c.getIDs().length
    }
    return -1
}
`

/**
 * Which of the linked account's Top Shot capability controllers the parent can
 * resolve as a withdraw provider. Verified 2026-09-29 (read-only) on Trevor's
 * link: 7 controllers, all resolvable from both parents.
 */
export const PROVIDER_CONTROLLERS_SCRIPT = `${IMPORTS}

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
    for ctl in c.capabilities.storage.getControllers(forPath: /storage/MomentCollection) {
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

/** Flow's per-transaction computation limit; a 50-moment batch sits well inside it. */
export const DELIVER_GAS_LIMIT = 9999
