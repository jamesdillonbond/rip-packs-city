import type {
  PinnacleFlowtyListing,
  PinnacleTraits,
} from "./types"

const FLOWTY_URL = "https://api2.flowty.io/collection/0xedf9df96c92f4595/Pinnacle"
const PAGE_SIZE = 24
const OFFSETS = [0, 24, 48, 72]

// ─── Fetch all pages from Flowty ─────────────────────────────────────────────

export async function fetchPinnacleListings(): Promise<PinnacleFlowtyListing[]> {
  const pages = await Promise.all(
    OFFSETS.map(async (offset) => {
      const res = await fetch(FLOWTY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          includeAllListings: true,
          limit: PAGE_SIZE,
          offset,
        }),
        cache: "no-store",
      })

      if (!res.ok) {
        throw new Error(`Flowty returned ${res.status} for offset ${offset}`)
      }

      const data = await res.json()
      // Flowty returns an array of listings at the top level
      return (data as PinnacleFlowtyListing[]) ?? []
    })
  )

  return pages.flat()
}

// ─── Parse raw trait array into typed object ─────────────────────────────────

export function parsePinnacleTraits(
  traits: { name: string; value: string }[]
): PinnacleTraits {
  const map = new Map(traits.map((t) => [t.name, t.value]))

  return {
    Variant: map.get("Variant") ?? "Standard",
    SetName: map.get("SetName") ?? "Unknown",
    Characters: map.get("Characters") ?? "Unknown",
    Studios: map.get("Studios") ?? "Unknown",
    SeriesName: map.get("SeriesName") ?? "Unknown",
    EditionType: map.get("EditionType") ?? "Open Edition",
    RoyaltyCodes: map.get("RoyaltyCodes") ?? "",
    IsChaser: map.get("IsChaser") ?? "false",
    Printing: map.get("Printing") ?? "1",
    MaturityDate: map.get("MaturityDate") ?? null,
    SerialNumber: map.get("SerialNumber") ?? null,
    EventName: map.get("EventName") ?? null,
  }
}

// ─── Build edition key from traits ───────────────────────────────────────────
// Format: "WDAS-OEV1-LION:Digital Display:1"

export function buildEditionKey(traits: PinnacleTraits): string {
  // Strip brackets: "[WDAS-OEV1-LION]" → "WDAS-OEV1-LION"
  const royaltyCode = traits.RoyaltyCodes.replace(/^\[|\]$/g, "")
  return `${royaltyCode}:${traits.Variant}:${traits.Printing}`
}

// ─── Lock check ──────────────────────────────────────────────────────────────

export function isLocked(traits: PinnacleTraits): boolean {
  if (!traits.MaturityDate) return false
  const maturity = Number(traits.MaturityDate)
  return maturity > Date.now() / 1000
}

// ─── Serial extraction ───────────────────────────────────────────────────────

export function getSerial(traits: PinnacleTraits): number | null {
  if (!traits.SerialNumber) return null
  const n = Number(traits.SerialNumber)
  return Number.isFinite(n) ? n : null
}
