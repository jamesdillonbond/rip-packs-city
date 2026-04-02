// Flowty API response types for Disney Pinnacle listings.
// Key difference from TopShot/AllDay: nftView lives under listing.nft,
// not directly on the listing object.

export interface PinnacleFlowtyTrait {
  name: string
  value: string
}

export interface PinnacleFlowtyNftView {
  serial?: number
  uuid?: string
  traits?: {
    traits: PinnacleFlowtyTrait[]
  }
}

export interface PinnacleFlowtyNft {
  id: string
  nftView?: PinnacleFlowtyNftView
}

export interface PinnacleFlowtyOrder {
  listingResourceID: string
  storefrontAddress?: string
  salePrice: number
  blockTimestamp?: number
}

export interface PinnacleFlowtyListing {
  nft: PinnacleFlowtyNft
  orders?: PinnacleFlowtyOrder[]
  card?: { title?: string; num?: number; max?: number }
  valuations?: { blended?: { usdValue?: number }; livetoken?: { usdValue?: number } }
}
