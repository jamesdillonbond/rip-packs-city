// transactions/hc_offer_only.cdc — the child OFFERS itself to a parent (publishToParent) but the parent never
// redeems it. HybridCustody.isChildOf() is already true here; getRedeemedStatus() is false. The pack contract
// must treat this as NOT linked.
import "HybridCustody"
import "CapabilityFactory"
import "CapabilityFilter"
import "ViewResolver"

transaction(parent: Address, factoryAddress: Address, filterAddress: Address) {
    prepare(childAcct: auth(Storage, Capabilities) &Account) {
        let acctCap = childAcct.capabilities.account.issue<auth(Storage, Contracts, Keys, Inbox, Capabilities) &Account>()
        if childAcct.storage.borrow<&HybridCustody.OwnedAccount>(from: HybridCustody.OwnedAccountStoragePath) == nil {
            childAcct.storage.save(<- HybridCustody.createOwnedAccount(acct: acctCap), to: HybridCustody.OwnedAccountStoragePath)
            childAcct.capabilities.publish(
                childAcct.capabilities.storage.issue<&{HybridCustody.OwnedAccountPublic, ViewResolver.Resolver}>(HybridCustody.OwnedAccountStoragePath),
                at: HybridCustody.OwnedAccountPublicPath
            )
        }
        let owned = childAcct.storage.borrow<auth(HybridCustody.Owner) &HybridCustody.OwnedAccount>(from: HybridCustody.OwnedAccountStoragePath)!
        let factory = getAccount(factoryAddress).capabilities.get<&CapabilityFactory.Manager>(CapabilityFactory.PublicPath)
        let filter = getAccount(filterAddress).capabilities.get<&{CapabilityFilter.Filter}>(CapabilityFilter.PublicPath)
        owned.publishToParent(parentAddress: parent, factory: factory, filter: filter)
    }
}
