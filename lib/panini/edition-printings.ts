// lib/panini/edition-printings.ts
//
// Panini (Top Shot parity, 2026-11-23): the edition page's "Parallel Printings" ladder. Top Shot builds it from
// `setID:playID::subID` keys and Candy from one player's printings inside a set; Panini has neither key. A Panini
// card's parallels are separate editions of the same product + player + CARD NUMBER — the last segment of the
// external id (`packcard-<product>_<cardset>_<card>_<number>`): Damian Lillard's 2021-22 Prizm Base #116 has eight
// printings from /1000 Base to /8 White Sparkle, each its own edition with its own market.
//
// The card number alone is not enough: in one product an insert can share a player's number (Lillard's 2022-23
// "Raining 3s" #9 and "Elite Dominators" #9 are different cards). So a ladder is also one FAMILY — Panini names a
// parallel "<card> Prizms <colour>" (also "Preferred Prizms" / "Choice Prizms"), or "<card> <colour>" beside a
// sibling named exactly "<card>" ("Base Holo" beside "Base"). An edition whose family has no other member gets no
// ladder.
//
// THREE STATES: a failed read returns ok:false and the section renders nothing (no ladder is a layout choice,
// never a claim); a card with one printing returns ok:true with no rows and the section self-hides. A failed FMV
// read keeps the ladder (names, mints, links are facts) with no prices — never $0. No FMV confidence (10-18).

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"

const PANINI_COLLECTION_ID = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"

export interface PaniniPrinting {
  externalId: string
  /** The parallel's own name relative to its card ("Prizms Gold"), or the card's set name for the root. */
  label: string
  setName: string
  mintCap: number | null
  thumbnailUrl: string | null
  fmvUsd: number | null
  isSelf: boolean
}

export interface PaniniPrintingRow {
  external_id: string
  set_name: string | null
  mint_cap: number | null
  thumbnail_url: string | null
}

const PRIZMS_RE = /^(.*?)\s+(?:(?:Preferred|Choice)\s+)?Prizms(?:\s|$)/

/** The card number — the external id's last `_` segment — or null when the key has another shape. */
export function paniniCardNumber(externalId: string): string | null {
  if (!externalId.startsWith("packcard-")) return null
  const parts = externalId.split("_")
  if (parts.length < 4) return null
  const n = parts[parts.length - 1]
  return /^\d+$/.test(n) ? n : null
}

/**
 * The family a set name belongs to among `names` (the same card number's set names). "X Prizms …" → "X";
 * otherwise "X Y" → "X" when a sibling is named exactly "X"; otherwise the name itself.
 */
export function paniniParallelFamily(setName: string, names: ReadonlySet<string>): string {
  const name = setName.trim()
  const m = PRIZMS_RE.exec(name)
  if (m && m[1].trim()) return m[1].trim()
  const words = name.split(/\s+/)
  for (let k = words.length - 1; k >= 1; k--) {
    const prefix = words.slice(0, k).join(" ")
    if (names.has(prefix)) return prefix
  }
  return name
}

/**
 * The ladder for `selfId` among `rows` (one product + player). Pure. Returns [] when the edition is not in rows,
 * has no card number, or its family has no other printing. Sorted by mint cap, most copies first.
 */
export function paniniPrintingLadder(selfId: string, rows: PaniniPrintingRow[]): Omit<PaniniPrinting, "fmvUsd">[] {
  const self = rows.find((r) => r.external_id === selfId)
  const num = paniniCardNumber(selfId)
  if (!self || !self.set_name || !num) return []
  const sameNumber = rows.filter((r) => r.set_name && paniniCardNumber(r.external_id) === num)
  const names = new Set(sameNumber.map((r) => (r.set_name as string).trim()))
  const family = paniniParallelFamily(self.set_name, names)
  const ladder = sameNumber.filter((r) => paniniParallelFamily(r.set_name as string, names) === family)
  if (ladder.length < 2) return []
  return ladder
    .map((r) => {
      const setName = (r.set_name as string).trim()
      const rest = setName.startsWith(family + " ") ? setName.slice(family.length + 1).trim() : ""
      return {
        externalId: r.external_id,
        label: rest || setName,
        setName,
        mintCap: typeof r.mint_cap === "number" ? r.mint_cap : null,
        thumbnailUrl: r.thumbnail_url ?? null,
        isSelf: r.external_id === selfId,
      }
    })
    .sort((a, b) => (b.mintCap ?? -1) - (a.mintCap ?? -1) || a.externalId.localeCompare(b.externalId))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function fetchPaniniPrintings(
  externalId: string,
  injected?: Db,
): Promise<{ ok: boolean; printings: PaniniPrinting[] }> {
  const db: Db = injected ?? supabaseAdmin
  if (!paniniCardNumber(externalId)) return { ok: true, printings: [] }
  try {
    const self = await withQueryDeadline<Array<{ product_set_id: number | null; player_name: string | null }>>(
      db.from("panini_editions").select("product_set_id,player_name").eq("external_id", externalId).limit(1),
      "edition/panini-printings-self",
      apiReadTimeoutMs(),
    )
    if (self.error) return { ok: false, printings: [] }
    const row = (self.data ?? [])[0]
    if (!row || row.product_set_id == null || !row.player_name) return { ok: true, printings: [] }
    const sibs = await withQueryDeadline<PaniniPrintingRow[]>(
      db.from("panini_editions")
        .select("external_id,set_name,mint_cap,thumbnail_url")
        .eq("player_name", row.player_name)
        .eq("product_set_id", row.product_set_id)
        .order("external_id", { ascending: true })
        .limit(400),
      "edition/panini-printings",
      apiReadTimeoutMs(),
    )
    if (sibs.error) return { ok: false, printings: [] }
    const ladder = paniniPrintingLadder(externalId, (sibs.data ?? []).filter((r) => typeof r.external_id === "string"))
    if (ladder.length < 2) return { ok: true, printings: [] }

    // FMV: the shared editions row (Panini collection) → edition_fmv_current, the price the edition page shows.
    const fmvBy = new Map<string, number | null>()
    const eds = await withQueryDeadline<Array<{ id: string; external_id: string }>>(
      db.from("editions").select("id,external_id").eq("collection_id", PANINI_COLLECTION_ID).in("external_id", ladder.map((p) => p.externalId)),
      "edition/panini-printings-ids",
      apiReadTimeoutMs(),
    )
    if (!eds.error && (eds.data ?? []).length > 0) {
      const extById = new Map((eds.data ?? []).map((e) => [e.id, e.external_id]))
      const fmv = await withQueryDeadline<Array<{ edition_id: string; fmv_usd: unknown }>>(
        db.from("edition_fmv_current").select("edition_id,fmv_usd").in("edition_id", [...extById.keys()]),
        "edition/panini-printings-fmv",
        apiReadTimeoutMs(),
      )
      if (!fmv.error) {
        for (const f of fmv.data ?? []) {
          const ext = extById.get(f.edition_id)
          const v = num(f.fmv_usd)
          if (ext) fmvBy.set(ext, v != null && v > 0 ? v : null)
        }
      }
    }
    return { ok: true, printings: ladder.map((p) => ({ ...p, fmvUsd: fmvBy.get(p.externalId) ?? null })) }
  } catch {
    return { ok: false, printings: [] }
  }
}
