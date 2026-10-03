// scripts/hc_link_status.cdc — [listed as a parent (offered OR redeemed), redeemed] for (child, parent), read the way the pack contract reads it.
import "HybridCustody"

access(all) fun main(child: Address, parent: Address): [Bool] {
    let o = getAccount(child).capabilities.borrow<&{HybridCustody.OwnedAccountPublic}>(HybridCustody.OwnedAccountPublicPath)
    if o == nil { return [false, false] }
    return [o!.getParentAddresses().contains(parent), o!.getRedeemedStatus(addr: parent) == true]
}
