/**
 * lib/pinnacle/pinnacleTypes.ts
 *
 * TypeScript types, constants, and helpers for Disney Pinnacle integration.
 * Mirrors the pattern established in lib/topshot/ but adapted for Pinnacle's
 * character/franchise/variant data model.
 *
 * Key differences from Top Shot:
 * - No "player" -> uses "character" (e.g., Scar, Buzz Lightyear)
 * - No "team" -> uses "franchise" (e.g., The Lion King, Toy Story)
 * - No "tier" -> uses "variant" (Standard, Brushed Silver, Golden, etc.)
 * - "studio" is the parent grouping (Disney, Pixar, Lucasfilm, 20th Century)
 * - Edition type: "Open Edition" (no serial) vs "Limited Edition" (serialized)
 * - Edition key format: "ROYALTY_CODE:VARIANT:PRINTING" (e.g., "WDAS-OEV1-LION:Standard:1")
 *
 * Flowty traits are stringified arrays like "[Grogu]" — use parseStringifiedArray().
 * Variant is available directly from the "Variant" trait — no derivation needed.
 */

// ── Edition / Pin Types ──────────────────────────────────────────────────────

export interface PinnacleEdition {
  id: string                    // = edition_key = "ROYALTY_CODE:VARIANT:PRINTING"
  externalId: string | null     // on-chain edition ID if known
  characterName: string
  franchise: string             // e.g., "The Lion King", "Star Wars Saga"
  studio: string                // e.g., "Walt Disney Animation Studios"
  setName: string               // e.g., "Walt Disney Animation Studios - The Lion King Vol.1"
  royaltyCode: string           // e.g., "WDAS-OEV1-LION"
  seriesYear: number | null     // 2023, 2024, 2025, 2026
  variantType: PinnacleVariant
  editionType: "Open Edition" | "Limited Edition"
  printing: number              // usually 1
  mintCount: number | null      // for Limited Edition; null for Open Edition
  isSerialized: boolean
  isChaser: boolean
  materials: string[]           // e.g., ["GOLD"], ["SILVER"]
  effects: string[]             // e.g., ["LED GLITCH"]
  size: string | null           // "MEDIUM"
  color: string | null          // "FULL COLOR"
  thickness: string | null      // "THIN"
  mintingDate: string | null    // ISO date
  thumbnailUrl: string | null
  editionKey: string            // same as id
}

export interface PinnaclePin {
  nftId: string                 // on-chain NFT ID (UInt64 as string)
  editionKey: string
  characterName: string
  franchise: string
  studio: string
  setName: string
  variantType: PinnacleVariant
  editionType: "Open Edition" | "Limited Edition"
  serialNumber: number | null   // only for Limited Edition
  mintCount: number | null
  thumbnailUrl: string | null
  fmv: number | null
  fmvConfidence: string | null
}

// ── Sniper Types ─────────────────────────────────────────────────────────────

export interface PinnacleSniperDeal {
  flowId: string
  nftId: string
  editionKey: string
  characterName: string
  franchise: string
  studio: string
  setName: string
  seriesYear: number | null
  variantType: PinnacleVariant
  editionType: "Open Edition" | "Limited Edition"
  serial: number | null
  mintCount: number | null
  askPrice: number
  baseFmv: number
  adjustedFmv: number
  discount: number              // 0-100 pct
  confidence: string
  serialMult: number
  isSpecialSerial: boolean
  serialSignal: string | null
  thumbnailUrl: string | null
  isLocked: boolean
  updatedAt: string
  buyUrl: string
  listingResourceID: string | null
  listingOrderID: string | null
  storefrontAddress: string | null
  source: "pinnacle"
  offerAmount: number | null
  offerFmvPct: number | null
}

// ── Variant Hierarchy ────────────────────────────────────────────────────────

export type PinnacleVariant =
  | "Standard"
  | "Brushed Silver"
  | "Silver Sparkle"
  | "Colored Enamel"
  | "Embellished Enamel"
  | "Golden"
  | "Digital Display"
  | "Limited Edition"
  | string  // fallback for unknown variants

export const PINNACLE_VARIANT_RANK: Record<string, number> = {
  "Standard": 1,
  "Brushed Silver": 2,
  "Silver Sparkle": 3,
  "Colored Enamel": 4,
  "Embellished Enamel": 5,
  "Golden": 6,
  "Digital Display": 7,
  "Limited Edition": 8,
}

export const PINNACLE_VARIANT_COLORS: Record<string, string> = {
  "Standard": "#9CA3AF",
  "Brushed Silver": "#C0C0C0",
  "Silver Sparkle": "#94A3B8",
  "Colored Enamel": "#F59E0B",
  "Embellished Enamel": "#D97706",
  "Golden": "#FFD700",
  "Digital Display": "#8B5CF6",
  "Limited Edition": "#EF4444",
}

export const PINNACLE_VARIANT_LABELS: Record<string, string> = {
  "Standard": "STD",
  "Brushed Silver": "SLV",
  "Silver Sparkle": "SSP",
  "Colored Enamel": "ENM",
  "Embellished Enamel": "EEN",
  "Golden": "GLD",
  "Digital Display": "DD",
  "Limited Edition": "LE",
}

// ── Studio Constants ─────────────────────────────────────────────────────────

export const PINNACLE_STUDIOS = [
  "Walt Disney Animation Studios",
  "Pixar Animation Studios",
  "Lucasfilm Ltd.",
  "20th Century Studios",
] as const

export type PinnacleStudio = typeof PINNACLE_STUDIOS[number]

export const PINNACLE_STUDIO_SHORT: Record<string, string> = {
  "Walt Disney Animation Studios": "Disney",
  "Pixar Animation Studios": "Pixar",
  "Lucasfilm Ltd.": "Star Wars",
  "20th Century Studios": "20th Century",
}

export const PINNACLE_STUDIO_COLORS: Record<string, string> = {
  "Walt Disney Animation Studios": "#3B82F6",  // blue
  "Pixar Animation Studios": "#10B981",         // green
  "Lucasfilm Ltd.": "#EAB308",                  // yellow
  "20th Century Studios": "#F97316",            // orange
}

// ── Contract Constants ───────────────────────────────────────────────────────

export const PINNACLE_CONTRACT_ADDRESS = "0xedf9df96c92f4595"
export const PINNACLE_CONTRACT_NAME = "Pinnacle"
export const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

// Flowty integration
export const FLOWTY_PINNACLE_ENDPOINT = "https://api2.flowty.io/collection/0xedf9df96c92f4595/Pinnacle"
export const FLOWTY_PINNACLE_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
}

export const PINNACLE_FLOWTY_BUY_URL = (nftId: string, rid?: string) =>
  rid
    ? `https://www.flowty.io/asset/0xedf9df96c92f4595/Pinnacle/NFT/${nftId}?listingResourceID=${rid}`
    : `https://www.flowty.io/asset/0xedf9df96c92f4595/Pinnacle/NFT/${nftId}`

export const PINNACLE_MARKETPLACE_URL = "https://disneypinnacle.com/marketplace"

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a stringified array from Flowty traits.
 * Flowty returns traits like "[Grogu]", "[Lucasfilm Ltd., Star Wars]", "[NONE]"
 * Strips brackets and splits on commas. Returns empty array for null/undefined.
 */
export function parseStringifiedArray(value: string | null | undefined): string[] {
  if (!value || typeof value !== "string") return []
  const trimmed = value.trim()
  if (trimmed === "" || trimmed === "[]") return []
  // Strip leading [ and trailing ]
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed
  if (!inner.trim()) return []
  return inner.split(",").map(s => s.trim()).filter(Boolean)
}

/**
 * Build edition key from Flowty trait data.
 * Format: "ROYALTY_CODE:VARIANT:PRINTING"
 */
export function buildPinnacleEditionKey(
  royaltyCode: string,
  variant: string,
  printing: number = 1
): string {
  return `${royaltyCode}:${variant}:${printing}`
}

/**
 * Parse an edition key back into components.
 */
export function parsePinnacleEditionKey(key: string): {
  royaltyCode: string
  variant: string
  printing: number
} {
  const parts = key.split(":")
  return {
    royaltyCode: parts[0] ?? "",
    variant: parts[1] ?? "Standard",
    printing: parseInt(parts[2] ?? "1", 10),
  }
}

/**
 * Variant rank -- higher = rarer/more valuable.
 */
export function pinnacleVariantRank(variant: string): number {
  return PINNACLE_VARIANT_RANK[variant] ?? 0
}

/**
 * Serial multiplier for Limited Edition pins.
 * Only applies to serialized pins (Limited Edition).
 * Open Edition pins always return 1.0.
 */
export function pinnacleSerialMultiplier(
  serial: number | null,
  mintCount: number | null,
  isSerialized: boolean
): number {
  if (!isSerialized || serial == null || mintCount == null || mintCount <= 0) {
    return 1.0
  }
  return 1 + 0.08 * (1 - serial / mintCount)
}

/**
 * Check if a serial number is "special".
 */
export function isPinnacleSpecialSerial(
  serial: number | null,
  mintCount: number | null
): { isSpecial: boolean; signal: string | null } {
  if (serial == null) return { isSpecial: false, signal: null }
  if (serial === 1) return { isSpecial: true, signal: "#1 Serial" }
  if (serial <= 10) return { isSpecial: true, signal: "Top 10 Serial" }
  if (mintCount && serial === mintCount) return { isSpecial: true, signal: "Last Serial" }
  return { isSpecial: false, signal: null }
}

/**
 * Extract studio short label.
 */
export function pinnacleStudioShort(studio: string): string {
  return PINNACLE_STUDIO_SHORT[studio] ?? studio
}

/**
 * Format variant for display with color.
 */
export function pinnacleVariantDisplay(variant: string): {
  label: string
  shortLabel: string
  color: string
  rank: number
} {
  return {
    label: variant,
    shortLabel: PINNACLE_VARIANT_LABELS[variant] ?? variant.substring(0, 3).toUpperCase(),
    color: PINNACLE_VARIANT_COLORS[variant] ?? "#6B7280",
    rank: PINNACLE_VARIANT_RANK[variant] ?? 0,
  }
}

/**
 * Sort comparator for variant types (rarer first).
 */
export function pinnacleVariantSort(a: string, b: string): number {
  return (PINNACLE_VARIANT_RANK[b] ?? 0) - (PINNACLE_VARIANT_RANK[a] ?? 0)
}

/**
 * Maps Flowty nftView.traits.traits array to a PinnacleEdition object.
 * Traits come as {name, value} pairs where array values are stringified like "[Grogu]".
 * Variant is available directly from the "Variant" trait.
 */
export function flowtyTraitsToPinnacleEdition(
  traits: Array<{ name: string; value: string }>
): Partial<PinnacleEdition> {
  const traitMap = new Map<string, string>()
  for (const t of traits) {
    traitMap.set(t.name, t.value)
  }

  const characters = parseStringifiedArray(traitMap.get("Characters"))
  const franchises = parseStringifiedArray(traitMap.get("Franchises"))
  const studios = parseStringifiedArray(traitMap.get("Studios"))
  const materials = parseStringifiedArray(traitMap.get("Materials"))
  const effects = parseStringifiedArray(traitMap.get("Effects"))
  const royaltyCodes = parseStringifiedArray(traitMap.get("RoyaltyCodes"))

  const royaltyCode = royaltyCodes[0] ?? ""
  const editionType = traitMap.get("EditionType") ?? "Open Edition"
  // Variant is directly available from the "Variant" trait
  const variant = traitMap.get("Variant") ?? "Standard"
  const printing = parseInt(traitMap.get("Printing") ?? "1", 10)
  const isChaser = traitMap.get("IsChaser") === "true"

  const mintingDateRaw = traitMap.get("MintingDate")
  let mintingDate: string | null = null
  if (mintingDateRaw) {
    const ts = parseInt(mintingDateRaw, 10)
    if (!isNaN(ts) && ts > 0) {
      // Timestamp could be seconds or ms
      const ms = ts < 1e12 ? ts * 1000 : ts
      mintingDate = new Date(ms).toISOString()
    }
  }

  return {
    characterName: characters[0] ?? "Unknown",
    franchise: franchises[0] ?? "Unknown",
    studio: studios[0] ?? "Unknown",
    setName: traitMap.get("SetName") ?? "",
    royaltyCode,
    seriesYear: parseInt(traitMap.get("SeriesName") ?? "0", 10) || null,
    variantType: variant,
    editionType: editionType as "Open Edition" | "Limited Edition",
    printing,
    isChaser,
    isSerialized: editionType === "Limited Edition",
    materials,
    effects,
    size: traitMap.get("Size") ?? null,
    color: traitMap.get("Color") ?? null,
    thickness: traitMap.get("Thickness") ?? null,
    mintingDate,
    editionKey: buildPinnacleEditionKey(royaltyCode, variant, printing),
  }
}
