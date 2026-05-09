// tests/cadence/stubs/TopShot.cdc
//
// TYPE-SHAPE MIRROR, NOT BEHAVIORAL MIRROR.
// For Cadence type-checker resolution only — never deploy this anywhere.
//
// The production contract at mainnet 0x0b2a3299cc857e29 is the real Top Shot
// NFT contract; flow dependencies install can pull it but the transitive
// chain (TopShotLocking, MetadataViews views, royalty registries) is not
// needed for this regression net. The production purchase-moment.ts
// transaction imports TopShot at the file level but never calls TopShot.X
// in its body — it borrows the buyer collection through the
// NonFungibleToken.CollectionPublic interface — so an empty contract is
// sufficient for import resolution.
//
// If a future test extends to assert on TopShot-specific receipt logic
// (e.g. play / set / serial number resolution), replace this stub with the
// pulled source from `flow dependencies install mainnet://...TopShot` and
// register the transitive chain in tests/cadence/flow.test.json.

access(all) contract TopShot {
    access(all) resource interface NFT {}
    init() {}
}
