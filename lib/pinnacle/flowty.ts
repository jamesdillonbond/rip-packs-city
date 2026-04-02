import type {
  PinnacleFlowtyListing,
  PinnacleTraits,
  FlowtyTrait,
  FlowtyResponse,
} from "./types"

const FLOWTY_ENDPOINT =
  "https://api2.flowty.io/collection/0xedf9df96c92f4595/Pinnacle"

const PAGE_SIZE = 24
const PAGE_COUNT = 4

// ─── Fetch all pages of Pinnacle listings from Flowty ────────────────────────

export async function fetchPinnacleListings(): Promise<PinnacleFlowtyListing[]> {
  const all: PinnacleFlowtyListing[] = []

  for (let page = 0; page < PAGE_COUNT; page++) {
    const offset = page * PAGE_SIZE
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        includeAllListings: true,
        offset,
        limit: PAGE_SIZE,
      }),
    })

    if (!res.ok) {
      throw new Error(
        `Flowty Pinnacle fetch failed (offset ${offset}): ${res.status} ${res.statusText}`
      )
    }

    const data: FlowtyResponse = await res.json()
    if (data.nfts?.length) {
      all.push(...data.nfts)
    }
  }

  return all
}

// ─── Parse raw Flowty traits into a typed object ─────────────────────────────

export function parsePinnacleTraits(
  traits: FlowtyTrait[]
): PinnacleTraits {
  const map = new Map<string, string>()
  for (const t of traits) {
    map.set(t.name, t.value)
  }

  // Strip brackets from Studios: "[Walt Disney Animation Studios]" → "Walt Disney Animation Studios"
  const rawStudios = map.get("Studios") ?? null
  const studios = rawStudios
    ? rawStudios.replace(/^\[/, "").replace(/\]$/, "")
    : null

  return {
    variant: map.get("Variant") ?? null,
    setName: map.get("SetName") ?? null,
    characters: map.get("Characters") ?? null,
    studios,
    seriesName: map.get("SeriesName") ?? null,
    editionType: map.get("EditionType") ?? null,
    royaltyCodes: map.get("RoyaltyCodes") ?? null,
    isChaser: map.get("IsChaser") === "true",
    printing: map.get("Printing") ?? null,
    maturityDate: map.get("MaturityDate") ?? null,
    serialNumber: map.get("SerialNumber")
      ? parseInt(map.get("SerialNumber")!, 10)
      : null,
    eventName: map.get("EventName") ?? null,
  }
}

// ─── Build a unique edition key from traits ──────────────────────────────────
// Format: "WDAS-OEV1-LION:Digital Display:1"
// Strip brackets from RoyaltyCodes: "[WDAS-OEV1-LION]" → "WDAS-OEV1-LION"

export function buildEditionKey(traits: PinnacleTraits): string {
  const royalty = traits.royaltyCodes
    ? traits.royaltyCodes.replace(/^\[/, "").replace(/\]$/, "")
    : "UNKNOWN"
  const variant = traits.variant ?? "Standard"
  const printing = traits.printing ?? "1"

  return `${royalty}:${variant}:${printing}`
}

// ─── Check if a pin is locked ────────────────────────────────────────────────
// Locked if MaturityDate trait exists AND its unix timestamp (seconds) > now

export function isLocked(traits: PinnacleTraits): boolean {
  if (!traits.maturityDate) return false
  const maturity = parseInt(traits.maturityDate, 10)
  if (isNaN(maturity)) return false
  return maturity > Date.now() / 1000
}

// ─── Get serial number (only LE pins have it) ────────────────────────────────

export function getSerial(traits: PinnacleTraits): number | null {
  return traits.serialNumber
}
