import NFTStorefrontV2 from 0x4eb8a10cb9f87357

transaction(storefrontAddress: Address) {
  execute {
    let sf = getAccount(storefrontAddress)
      .capabilities
      .borrow<&{NFTStorefrontV2.StorefrontPublic}>(NFTStorefrontV2.StorefrontPublicPath)
      ?? panic("Cannot borrow storefront")

    sf.cleanupExpiredListings(fromIndex: 0, toIndex: 173)
  }
}
