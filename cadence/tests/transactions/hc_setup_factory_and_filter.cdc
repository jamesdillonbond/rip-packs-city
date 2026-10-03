// transactions/hc_setup_factory_and_filter.cdc — gives the signer an (empty) CapabilityFactory.Manager and an
// AllowAllFilter, the two capabilities a child account must name when publishing itself to a parent.
import "CapabilityFactory"
import "CapabilityFilter"

transaction {
    prepare(acct: auth(Storage, Capabilities) &Account) {
        if acct.storage.borrow<&AnyResource>(from: CapabilityFactory.StoragePath) == nil {
            acct.storage.save(<- CapabilityFactory.createFactoryManager(), to: CapabilityFactory.StoragePath)
            acct.capabilities.publish(acct.capabilities.storage.issue<&CapabilityFactory.Manager>(CapabilityFactory.StoragePath), at: CapabilityFactory.PublicPath)
        }
        if acct.storage.borrow<&AnyResource>(from: CapabilityFilter.StoragePath) == nil {
            acct.storage.save(<- CapabilityFilter.createFilter(Type<@CapabilityFilter.AllowAllFilter>()), to: CapabilityFilter.StoragePath)
            acct.capabilities.publish(acct.capabilities.storage.issue<&{CapabilityFilter.Filter}>(CapabilityFilter.StoragePath), at: CapabilityFilter.PublicPath)
        }
    }
}
