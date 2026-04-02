/**
 * lib/pinnacle/pinnacleTypes.ts
 * Type definitions and parsing helpers for Disney Pinnacle pins on Flow.
 * Contract: A.0xedf9df96c92f4595.Pinnacle
 */

export type PinnacleVariant =
  | "Standard"
  | "Brushed Silver"
  | "Silver Sparkle"
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
  | "Limited Edition"
  | "Limited Event Edition"
  | "Legendary Edition"
  | "Open Event Edition"
  | "Starter Edition"
  | "Unknown";

export type PinnacleFranchise = "Disney" | "Pixar" | "Star Wars" | "Unknown";

export type PinnacleEditionType =
  | "Open Edition"
  | "Open Event Edition"
  | "Limited Edition"
  | "Limited Event Edition"
  | "Legendary Edition"
  | "Starter Edition"
  | "Unknown";

export interface PinnacleSniperDeal {
  flowId: string;
  nftId: string;
  editionId: string;
  characterName: string;
  franchise: PinnacleFranchise;
  setName: string;
  seriesYear: number;
  variant: PinnacleVariant;
  editionType: string;
  isChaser: boolean;
  serial: number | null;
  mintCount: number;
  askPrice: number;
  baseFmv: number;
  adjustedFmv: number;
  discount: number;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NO_DATA";
  serialMult: number;
  isSpecialSerial: boolean;
  serialSignal: string | null;
  thumbnailUrl: null;
  isLocked: boolean;
  updatedAt: string | null;
  buyUrl: string;
  listingResourceID: string | null;
  listingOrderID: string | null;
  storefrontAddress: string | null;
  source: "flowty";
  offerAmount: null;
  offerFmvPct: null;
}

export const PINNACLE_VARIANT_RANK: Record<PinnacleVariant, number> = {
  "Unknown": 0,
  "Starter Edition": 1,
  "Standard": 1,
  "Colored Enamel": 2,
  "Brushed Silver": 2,
  "Open Event Edition": 2,
  "Silver Sparkle": 3,
  "Radiant Chrome": 3,
  "Embellished Enamel": 3,
  "Luxe Marble": 4,
  "Golden": 4,
  "Color Splash": 4,
  "Digital Display": 6,
  "Limited Edition": 8,
  "Limited Event Edition": 8,
  "Apex": 9,
  "Quartis": 9,
  "Quinova": 9,
  "Xenith": 9,
  "Legendary Edition": 10,
};

export const PINNACLE_VARIANT_COLORS: Record<PinnacleVariant, string> = {
  "Unknown": "#6B7280",
  "Starter Edition": "#6B7280",
  "Standard": "#9CA3AF",
  "Colored Enamel": "#9CA3AF",
  "Open Event Edition": "#9CA3AF",
  "Brushed Silver": "#C0C0C0",
  "Silver Sparkle": "#E2E8F0",
  "Radiant Chrome": "#E2E8F0",
  "Embellished Enamel": "#E2E8F0",
  "Luxe Marble": "#A78BFA",
  "Golden": "#F59E0B",
  "Color Splash": "#F59E0B",
  "Digital Display": "#A855F7",
  "Limited Edition": "#EF4444",
  "Limited Event Edition": "#EC4899",
  "Apex": "#EC4899",
  "Quartis": "#EC4899",
  "Quinova": "#EC4899",
  "Xenith": "#EC4899",
  "Legendary Edition": "#F97316",
};

const VARIANT_MAP: Record<string, PinnacleVariant> = {
  "standard": "Standard",
  "silver sparkle": "Silver Sparkle",
  "brushed silver": "Brushed Silver",
  "radiant chrome": "Radiant Chrome",
  "golden": "Golden",
  "digital display": "Digital Display",
  "luxe marble": "Luxe Marble",
  "color splash": "Color Splash",
  "colored enamel": "Colored Enamel",
  "embellished enamel": "Embellished Enamel",
  "apex": "Apex",
  "quartis": "Quartis",
  "quinova": "Quinova",
  "xenith": "Xenith",
  "limited edition": "Limited Edition",
  "limited event edition": "Limited Event Edition",
  "legendary edition": "Legendary Edition",
  "open event edition": "Open Event Edition",
  "starter edition": "Starter Edition",
};

// Parse a variant string to PinnacleVariant enum
export function parseVariant(raw: string | undefined): PinnacleVariant {
  if (!raw) return "Unknown";
  return VARIANT_MAP[raw.toLowerCase().trim()] ?? "Unknown";
}

// Parse Studios trait "[Walt Disney Animation Studios]" -> PinnacleFranchise
export function parseFranchise(studios: string): PinnacleFranchise {
  if (!studios) return "Unknown";
  const r = studios.toLowerCase();
  if (r.includes("lucasfilm")) return "Star Wars";
  if (r.includes("pixar")) return "Pixar";
  if (r.includes("disney") || r.includes("20th century")) return "Disney";
  return "Unknown";
}

// Parse a trait from the nftView.traits array
export function parseTrait(
  traits: Array<{ name: string; value: string }>,
  name: string
): string {
  return traits.find(t => t.name === name)?.value ?? "";
}

// Parse Characters trait "[Scar]" -> "Scar" (first character)
export function parseCharacters(raw: string): string {
  if (!raw) return "Unknown";
  return raw.replace(/^\[|\]$/g, "").split(",")[0].trim() || "Unknown";
}

// Parse RoyaltyCodes trait "[WDAS-OEV1-LION]" -> "WDAS-OEV1-LION"
export function parseRoyaltyCode(raw: string): string {
  if (!raw) return "";
  return raw.replace(/^\[|\]$/g, "").split(",")[0].trim();
}

// Build edition key: royaltyCode + variant + printing
// e.g. "WDAS-OEV1-LION:Digital Display:1"
export function buildEditionKey(
  royaltyCode: string,
  variant: string,
  printing: string
): string {
  return `${royaltyCode}:${variant}:${printing || "1"}`;
}

// Check if pin is locked via MaturityDate trait
export function isPinLocked(
  traits: Array<{ name: string; value: string }>
): boolean {
  const maturity = parseTrait(traits, "MaturityDate");
  if (!maturity) return false;
  const ts = parseInt(maturity, 10);
  if (isNaN(ts)) return false;
  return ts > Date.now() / 1000;
}

// Parse serial number from SerialNumber trait (LE pins only)
export function parseSerial(
  traits: Array<{ name: string; value: string }>
): number | null {
  const raw = parseTrait(traits, "SerialNumber");
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

// Serial multiplier for special serials (LE pins)
export function pinnacleSerialMultiplier(
  serial: number | null,
  mintCount: number
): { mult: number; signal: string | null; isSpecial: boolean } {
  if (serial === null) return { mult: 1, signal: null, isSpecial: false };
  if (serial === 1) return { mult: 8, signal: "LE #1", isSpecial: true };
  if (mintCount > 0 && serial === mintCount)
    return { mult: 1.3, signal: `Last #${serial}`, isSpecial: true };
  if (serial <= 10) return { mult: 1.5, signal: `#${serial}`, isSpecial: true };
  return { mult: 1, signal: null, isSpecial: false };
}
