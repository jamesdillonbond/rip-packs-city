// ── Disney Pinnacle Type Definitions ─────────────────────────────

// ── Enums / Union Types ──────────────────────────────────────────

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

// ── Parsed Traits ────────────────────────────────────────────────

export interface PinnacleTraits {
  variant: PinnacleVariant | string
  setName: string
  characters: string
  studios: string
  seriesName: string
  editionType: PinnacleEditionType | string
  royaltyCodes: string
  isChaser: boolean
  printing: string
  maturityDate: string | null
  serialNumber: number | null
  eventName: string | null
}

// ── Database Models ──────────────────────────────────────────────

export interface PinnacleEdition {
  id: number
  edition_key: string
  set_name: string
  series_name: string
  characters: string
  studios: string
  variant: string
  edition_type: string
  royalty_codes: string
  is_chaser: boolean
  printing: string
  floor_price_usd: number | null
  fmv_usd: number | null
  fmv_confidence: FmvConfidence
  created_at: string
  updated_at: string
}

export interface PinnacleFmvSnapshot {
  id: number
  edition_key: string
  fmv_usd: number | null
  floor_price_usd: number | null
  fmv_confidence: FmvConfidence
  sample_size: number
  median_sale_usd: number | null
  avg_sale_usd: number | null
  created_at: string
  updated_at: string
}

export interface PinnacleSale {
  id: number
  edition_key: string
  flow_id: string
  serial_number: number | null
  sale_price_usd: number
  payment_token: string
  sold_at: string
  created_at: string
}

// ── Flowty API Response Types ────────────────────────────────────

export interface FlowtyTrait {
  name: string
  value: string
}

export interface FlowtyOrder {
  salePrice: number
  paymentTokenIdentifier?: string
}

export interface FlowtyValuation {
  blended?: { usdValue: number }
}

export interface FlowtyNftView {
  traits?: { traits: FlowtyTrait[] }
}

export interface PinnacleFlowtyListing {
  flowNftId: string
  nftView: FlowtyNftView
  orders: FlowtyOrder[]
  valuations?: FlowtyValuation
}

export interface FlowtyApiResponse {
  nfts: PinnacleFlowtyListing[]
}
