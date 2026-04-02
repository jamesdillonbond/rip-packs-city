// ─── Disney Pinnacle Types ───────────────────────────────────────────────────

// Variant union (confirmed from Flowty trait data)
export type PinnacleVariant =
  | "Standard"
  | "Silver Sparkle"
  | "Brushed Silver"
  | "Radiant Chrome"
  | "Luxe Marble"
  | "Golden"
  | "Digital Display"
  | "Color Splash"
  | "Colored Enamel"
  | "Embellished Enamel"
  | "Apex"
  | "Quartis"
  | "Quinova"
  | "Xenith"

export const PINNACLE_VARIANTS: PinnacleVariant[] = [
  "Standard",
  "Silver Sparkle",
  "Brushed Silver",
  "Radiant Chrome",
  "Luxe Marble",
  "Golden",
  "Digital Display",
  "Color Splash",
  "Colored Enamel",
  "Embellished Enamel",
  "Apex",
  "Quartis",
  "Quinova",
  "Xenith",
]

// Edition type union
export type PinnacleEditionType =
  | "Open Edition"
  | "Open Event Edition"
  | "Limited Edition"
  | "Limited Event Edition"
  | "Legendary Edition"
  | "Starter Edition"

export const PINNACLE_EDITION_TYPES: PinnacleEditionType[] = [
  "Open Edition",
  "Open Event Edition",
  "Limited Edition",
  "Limited Event Edition",
  "Legendary Edition",
  "Starter Edition",
]

// Studio union
export type PinnacleStudio =
  | "Walt Disney Animation Studios"
  | "Pixar Animation Studios"
  | "Lucasfilm Ltd."
  | "20th Century Studios"

export const PINNACLE_STUDIOS: PinnacleStudio[] = [
  "Walt Disney Animation Studios",
  "Pixar Animation Studios",
  "Lucasfilm Ltd.",
  "20th Century Studios",
]

// Typed trait object parsed from Flowty nftView.traits.traits
export interface PinnacleTraits {
  variant: string | null
  setName: string | null
  characters: string | null
  studios: string | null
  seriesName: string | null
  editionType: string | null
  royaltyCodes: string | null
  isChaser: boolean
  printing: string | null
  maturityDate: string | null
  serialNumber: number | null
  eventName: string | null
}

// ─── Database Models ─────────────────────────────────────────────────────────

// Matches pinnacle_editions table
export interface PinnacleEdition {
  id: string
  edition_key: string
  set_name: string | null
  series_name: string | null
  characters: string | null
  variant: string | null
  edition_type: string | null
  studios: string | null
  royalty_codes: string | null
  is_chaser: boolean
  printing: string | null
  event_name: string | null
  floor_price_usd: number | null
  fmv_usd: number | null
  fmv_confidence: string
  listings_count: number
  created_at: string
  updated_at: string
}

// Matches pinnacle_fmv_snapshots table
export interface PinnacleFmvSnapshot {
  id: string
  edition_key: string
  fmv_usd: number | null
  floor_price_usd: number | null
  median_price_usd: number | null
  sales_count_7d: number
  sales_count_30d: number
  confidence: string
  snapshot_date: string
  created_at: string
}

// Matches pinnacle_sales table
export interface PinnacleSale {
  id: string
  edition_key: string
  sale_price_usd: number
  serial_number: number | null
  seller_address: string | null
  buyer_address: string | null
  sold_at: string
  created_at: string
}

// ─── Flowty API Response Types ───────────────────────────────────────────────

export interface FlowtyTrait {
  name: string
  value: string
}

export interface FlowtyOrder {
  salePrice: number
  paymentTokenType: string
}

export interface FlowtyNftView {
  traits: {
    traits: FlowtyTrait[]
  }
}

export interface PinnacleFlowtyListing {
  nftID: string
  nftView: FlowtyNftView
  orders: FlowtyOrder[]
  valuations?: {
    blended?: {
      usdValue: number
    }
  }
}

export interface FlowtyResponse {
  nfts: PinnacleFlowtyListing[]
  totalCount: number
}
