// ── Flowty API Client for Disney Pinnacle ────────────────────────

import type {
  PinnacleFlowtyListing,
  FlowtyApiResponse,
  FlowtyTrait,
  PinnacleTraits,
} from "./types"

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0xedf9df96c92f4595/Pinnacle"
const PAGE_SIZE = 24
const PAGE_OFFSETS = [0, 24, 48, 72]

/**
 * Fetch all listed Pinnacle pins from Flowty (4 pages of 24).
 */
export async function fetchPinnacleListings(): Promise<PinnacleFlowtyListing[]> {
  const pages = await Promise.all(
    PAGE_OFFSETS.map(async (offset) => {
      const res = await fetch(FLOWTY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          includeAllListings: true,
          batchSize: PAGE_SIZE,
          offset,
        }),
        cache: "no-store",
      })

      if (!res.ok) {
        console.error(`[PINNACLE_FLOWTY] Page offset=${offset} failed: ${res.status}`)
        return []
      }

      const data = (await res.json()) as FlowtyApiResponse
      return data.nfts ?? []
    })
  )

  return pages.flat()
}

/**
 * Parse raw Flowty trait array into a typed PinnacleTraits object.
 */
export function parsePinnacleTraits(traits: FlowtyTrait[]): PinnacleTraits {
  const map = new Map(traits.map((t) => [t.name, t.value]))

  return {
    variant: map.get("Variant") ?? "Standard",
    setName: map.get("SetName") ?? "",
    characters: map.get("Characters") ?? "",
    studios: stripBrackets(map.get("Studios") ?? ""),
    seriesName: map.get("SeriesName") ?? "",
    editionType: map.get("EditionType") ?? "",
    royaltyCodes: stripBrackets(map.get("RoyaltyCodes") ?? ""),
    isChaser: map.get("IsChaser") === "true",
    printing: map.get("Printing") ?? "1",
    maturityDate: map.get("MaturityDate") ?? null,
    serialNumber: map.has("SerialNumber") ? Number(map.get("SerialNumber")) : null,
    eventName: map.get("EventName") ?? null,
  }
}

/**
 * Build a unique edition key from traits.
 * Format: "ROYALTY_CODE:Variant:Printing"
 */
export function buildEditionKey(traits: PinnacleTraits): string {
  return `${traits.royaltyCodes}:${traits.variant}:${traits.printing}`
}

/**
 * Check if a pin is locked (maturity date is in the future).
 */
export function isLocked(traits: PinnacleTraits): boolean {
  if (!traits.maturityDate) return false
  const maturityUnix = Number(traits.maturityDate)
  return maturityUnix > Date.now() / 1000
}

/**
 * Get serial number (only Limited Edition pins have one).
 */
export function getSerial(traits: PinnacleTraits): number | null {
  return traits.serialNumber
}

// ── Helpers ──────────────────────────────────────────────────────

/** Strip surrounding brackets: "[WDAS-OEV1-LION]" → "WDAS-OEV1-LION" */
function stripBrackets(value: string): string {
  return value.replace(/^\[|\]$/g, "")
}
