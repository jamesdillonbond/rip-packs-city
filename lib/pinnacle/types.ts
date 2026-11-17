// ─── Enums / Union Types ─────────────────────────────────────────────────────

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

export type PinnacleEditionType =
  | "Open Edition"
  | "Open Event Edition"
  | "Limited Edition"
  | "Limited Event Edition"
  | "Legendary Edition"
  | "Starter Edition"

export type PinnacleStudio =
  | "Walt Disney Animation Studios"
  | "Pixar Animation Studios"
  | "Lucasfilm Ltd."
  | "20th Century Studios"

export type FmvConfidence =
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "ASK_ONLY"
  | "SALES_ONLY"
  | "STALE"
  | "NO_DATA"

// ─── Database Row Types ──────────────────────────────────────────────────────

export interface PinnacleEdition {
  id: string                  // edition_key (PK)
  external_id: string | null
  character_name: string
  franchise: string
  set_name: string
  royalty_code: string | null
  series_year: number | null
  variant_type: string
  edition_type: string
  printing: number
  mint_count: number | null
  is_serialized: boolean
  is_chaser: boolean
  thumbnail_url: string | null
  created_at: string
  updated_at: string
}

export interface PinnacleFmvSnapshot {
  id: number
  edition_id: string
  fmv_usd: number
  wap_usd: number | null
  floor_usd: number | null
  confidence: FmvConfidence
  days_since_sale: number | null
  sales_count_30d: number | null
  computed_at: string
}

export interface PinnacleSale {
  id: string
  edition_id: string | null
  nft_id: string | null
  sale_price_usd: number
  serial_number: number | null
  sold_at: string
  source: string
  created_at: string
}

// ─── Flowty API Types ────────────────────────────────────────────────────────

export interface PinnacleTraits {
  Variant: string
  SetName: string
  Characters: string
  Studios: string
  SeriesName: string
  EditionType: string
  RoyaltyCodes: string
  IsChaser: string
  Printing: string
  MaturityDate: string | null
  SerialNumber: string | null
  EventName: string | null
}

export interface PinnacleFlowtyOrder {
  salePrice: number
  listingResourceID: string
}

export interface PinnacleFlowtyNftView {
  id: string
  name: string
  thumbnail: string
  traits: {
    traits: { name: string; value: string }[]
  }
}

export interface PinnacleFlowtyListing {
  nftView: PinnacleFlowtyNftView
  orders: PinnacleFlowtyOrder[]
}
