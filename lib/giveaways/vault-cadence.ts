// lib/giveaways/vault-cadence.ts
//
// Cadence for the giveaway VAULT (Trevor, 2026-11-08: "Is there a way for the
// moments to instantly flow to the pack openers upon opening the pack?" → "Do
// what makes sense and proceed with it all the way through"). The vault is a
// plain Flow account, separate from every other RPC key, that holds ONLY the
// pools of drops the sponsor chose to fund. The server signs exactly two kinds
// of transaction as the vault:
//   * VAULT_SETUP_CADENCE — once: give the vault a Top Shot collection.
//   * DELIVER_OWN_BATCH_CADENCE (lib/giveaways/deliver-cadence.ts, unchanged) —
//     Moments out of the vault to the recipients the DATABASE recorded for a
//     claim (or back to the account each Moment was funded from).
// Every send is simulated first with the matching script, same discipline as
// "Deliver all".
//
// The setup statements follow the Top Shot contract's own init() on mainnet
// (read 2026-11-08 from 0x0b2a3299cc857e29): save a Collection at
// /storage/MomentCollection and publish a `&Collection` capability at
// /public/MomentCollection — the path every Top Shot deposit uses.

const IMPORTS = `import NonFungibleToken from 0x1d7e57aa55817448
import TopShot from 0x0b2a3299cc857e29`

const SETUP_STATEMENTS = `
        if acct.storage.borrow<&TopShot.Collection>(from: /storage/MomentCollection) == nil {
            acct.storage.save(<- TopShot.createEmptyCollection(nftType: Type<@TopShot.NFT>()), to: /storage/MomentCollection)
        }
        acct.capabilities.unpublish(/public/MomentCollection)
        acct.capabilities.publish(
            acct.capabilities.storage.issue<&TopShot.Collection>(/storage/MomentCollection),
            at: /public/MomentCollection
        )`

export const VAULT_SETUP_CADENCE = `${IMPORTS}

transaction {
    prepare(acct: auth(BorrowValue, SaveValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account) {${SETUP_STATEMENTS}
    }
}
`

/** Runs the setup in memory (a script's changes are discarded) and reports whether a deposit would then reach the vault. */
export const VAULT_SETUP_SIMULATION_SCRIPT = `${IMPORTS}

access(all) fun main(vault: Address): Bool {
        let acct = getAuthAccount<auth(BorrowValue, SaveValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account>(vault)${SETUP_STATEMENTS}
        return getAccount(vault).capabilities.borrow<&{NonFungibleToken.Receiver}>(/public/MomentCollection) != nil
}
`

/** [Top Shot moments held ("-1" = no collection), FLOW balance (UFix64 text), storage used, storage capacity (bytes)] */
export const VAULT_STATUS_SCRIPT = `import TopShot from 0x0b2a3299cc857e29

access(all) fun main(vault: Address): [String] {
    let acct = getAccount(vault)
    let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
    let held = col == nil ? "-1" : col!.getIDs().length.toString()
    return [held, acct.balance.toString(), acct.storage.used.toString(), acct.storage.capacity.toString()]
}
`
