import { promises as fs } from "fs"
import path from "path"
import { getOrSetCache } from "@/lib/cache"
import {
  buildEditionScopeKey,
  normalizeParallel,
  normalizeSetName,
} from "@/lib/wallet-normalize"

export type EditionMarketRow = {
  editionKey?: string | null
  setName?: string | null
  playerName?: string | null
  parallel?: string | null
  subedition?: string | null

  lowAsk?: number | string | null
  bestOffer?: number | string | null
  lastSale?: number | string | null

  source?: string | null
  notes?: string[] | null
  aliases?: string[] | null
  tags?: string[] | null
}

export type EditionMarketResolved = {
  scopeKey: string
  lowAsk: number | null
  bestOffer: number | null
  lastSale: number | null
  source: string | null
  notes: string[]
  tags: string[]
}

const TTL_MS = 1000 * 60 * 5

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string")
}

async function loadEditionMarketFile(): Promise<EditionMarketRow[]> {
  return getOrSetCache("edition-market-data", TTL_MS, async () => {
    const filePath = path.join(process.cwd(), "public", "edition-market-data.json")

    try {
      const raw = await fs.readFile(filePath, "utf8")
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? (parsed as EditionMarketRow[]) : []
    } catch {
      return []
    }
  })
}

function buildCanonicalScopeKey(row: EditionMarketRow) {
  return buildEditionScopeKey({
    editionKey: row.editionKey ?? null,
    setName: normalizeSetName(row.setName ?? null),
    playerName: row.playerName ?? null,
    parallel: normalizeParallel(row.parallel ?? row.subedition ?? ""),
    subedition: normalizeParallel(row.subedition ?? row.parallel ?? ""),
  })
}

export async function getEditionMarketRows() {
  return loadEditionMarketFile()
}

export async function getEditionMarketMap() {
  const rows = await loadEditionMarketFile()
  const map = new Map<string, EditionMarketResolved>()

  for (const row of rows) {
    const canonicalKey = buildCanonicalScopeKey(row)

    const resolved: EditionMarketResolved = {
      scopeKey: canonicalKey,
      lowAsk: toNum(row.lowAsk),
      bestOffer: toNum(row.bestOffer),
      lastSale: toNum(row.lastSale),
      source: row.source ?? "edition-market-file",
      notes: toStringArray(row.notes),
      tags: toStringArray(row.tags),
    }

    map.set(canonicalKey, resolved)

    const aliases = toStringArray(row.aliases)
    for (const alias of aliases) {
      const cleaned = alias.trim()
      if (cleaned) {
        map.set(cleaned, resolved)
      }
    }
  }

  return map
}