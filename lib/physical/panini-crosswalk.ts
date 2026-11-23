/**
 * Panini digital edition -> physical card matcher (prototype, NOT wired).
 *
 * The Panini NFT lines are licensed digital versions of Panini's paper programs
 * ("2024-25 Panini NFT Prizm Basketball" <-> "2024-25 Panini Prizm Basketball"),
 * with the same parallel names (Silver, Gold /10, Black 1/1 …). The draft view
 * docs/physical/panini-physical-crosswalk-draft.sql gives each digital edition
 * its paper key and the PERSON (ESPN id). This module decides which card from a
 * licensed feed's catalogue search (HobbyCardIndex) is that paper card.
 *
 * Rules — the same as RPC's identity rules (a-name-is-not-a-person):
 *   * Every hard field must agree: season year, program, player, parallel, and the
 *     card number when both sides carry one (it separates Caitlin Clark 2024 Prizm
 *     WNBA #22 from her #145 variation — same player, product and parallel).
 *   * More than one surviving candidate = AMBIGUOUS. Never pick one.
 *   * A digital print run that differs from the paper one (digital Silver /424
 *     vs unnumbered paper Silver) still links, but is flagged
 *     printRunMatch=false: those two are not like-for-like and a comparison
 *     must say so or leave them out.
 *
 * Pure: no I/O.
 */

export type PaperKey = {
  physicalProduct: string // "2024-25 Panini Prizm Basketball"
  subset: string // "Base", "Fireworks", "Base Legends" …
  parallel: string // "Gold Shimmer", "Silver", "Base"
  digitalMintCap: number | null
  playerName: string
  /** Paper card number, read from the digital edition key (crosswalk view `card_number`). */
  cardNumber?: string | null
}

export type ParsedProduct = {
  season: string // "2024-25" or "2024"
  startYear: number
  program: string // "Prizm"
}

// Longest first so "Donruss Optic" wins over "Donruss".
export const PANINI_PROGRAMS = [
  "Donruss Optic",
  "Court Kings",
  "Silhouette",
  "Obsidian",
  "Flawless",
  "Spectra",
  "Origins",
  "Donruss",
  "Mosaic",
  "Select",
  "Prizm",
  "Hoops",
  "Score",
] as const

export function parsePhysicalProduct(name: string): ParsedProduct | null {
  const m = name.match(/^(\d{4})(?:-(\d{2}))?\s+Panini\s+(.+)$/i)
  if (!m) return null
  const rest = m[3].toLowerCase()
  const program = PANINI_PROGRAMS.find((p) => rest.startsWith(p.toLowerCase() + " ") || rest === p.toLowerCase())
  if (!program) return null
  return { season: m[2] ? `${m[1]}-${m[2]}` : m[1], startYear: Number(m[1]), program }
}

export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const SUFFIX = /^(jr|sr|ii|iii|iv)$/

function nameTokens(name: string): string[] {
  return fold(name)
    .split(" ")
    .filter((t) => t.length > 0 && !SUFFIX.test(t))
}

/** Parses a card number ("#136", "No. 136") out of a title; never a print run ("#/10"). */
export function cardNumberOf(title: string): string | null {
  const m = title.match(/(?:#|\bno\.?\s*)(\d{1,4})\b(?!\s*\/)/i)
  return m ? String(Number(m[1])) : null
}

/** Parses "/10", "#/10", "/ 10" and "1/1" print runs out of a card title. */
export function printRunOf(title: string): number | null {
  const one = /\b1\s*\/\s*1\b/.test(title)
  if (one) return 1
  const m = title.match(/(?:^|[\s#(])\/\s*(\d{1,4})\b/)
  return m ? Number(m[1]) : null
}

export type FeedCard = {
  id: string
  name: string // full catalogue title
  year: number | null
  setName: string | null
  playerName: string | null
  cardNumber?: string | null
}

export type CandidateVerdict = {
  id: string
  accept: boolean
  reasons: string[] // why rejected (empty when accepted)
  printRunMatch: boolean | null // null = paper print run unknown
}

export function judgeCandidate(key: PaperKey, c: FeedCard): CandidateVerdict {
  const reasons: string[] = []
  const prod = parsePhysicalProduct(key.physicalProduct)
  if (!prod) return { id: c.id, accept: false, reasons: ["unparseable product"], printRunMatch: null }
  const hay = fold(`${c.setName ?? ""} ${c.name}`)

  // Season: a feed may key "2024-25" by either 2024 or 2025; a mismatch outside that is a different card.
  const yearOk =
    c.year == null
      ? hay.includes(fold(prod.season))
      : c.year === prod.startYear || (prod.season.includes("-") && c.year === prod.startYear + 1)
  if (!yearOk) reasons.push("year")

  if (!hay.includes(fold(prod.program))) reasons.push("program")
  // A title naming ANOTHER program is another card. "Prizm" is skipped here: it is
  // also a parallel word on Select / Mosaic / Optic paper ("Select Silver Prizm").
  // A program contained in the key's (Donruss inside Donruss Optic) is skipped; one
  // CONTAINING the key's (Donruss Optic for a Donruss key) still rejects.
  for (const other of PANINI_PROGRAMS) {
    if (other === prod.program || other === "Prizm") continue
    if (fold(prod.program).includes(fold(other))) continue
    if (new RegExp(`\\b${fold(other)}\\b`).test(hay)) {
      reasons.push(`other program: ${other}`)
      break
    }
  }

  // Player: every name token (suffixes aside) must appear; when the feed names the
  // player, the token SETS must be equal (Gerald Riggs vs Gerald Riggs Jr is the
  // suffix case the person crosswalk already settled).
  const want = nameTokens(key.playerName)
  if (c.playerName) {
    const got = nameTokens(c.playerName)
    if (want.length !== got.length || want.some((t) => !got.includes(t))) reasons.push("player")
  } else if (want.some((t) => !new RegExp(`\\b${t}\\b`).test(hay))) {
    reasons.push("player")
  }

  // Card number: when both sides carry one they must be equal.
  const keyNo = key.cardNumber ? String(Number(key.cardNumber)) : null
  const candNo = c.cardNumber != null && c.cardNumber !== "" ? String(Number(c.cardNumber)) : cardNumberOf(c.name)
  if (keyNo && candNo && keyNo !== candNo) reasons.push("card number")

  // Subset (insert) and parallel tokens must be present. "Base" adds nothing.
  for (const part of [key.subset, key.parallel]) {
    if (!part || /^base$/i.test(part)) continue
    const toks = fold(part).split(" ").filter((t) => t !== "base")
    if (toks.some((t) => !new RegExp(`\\b${t}\\b`).test(hay))) {
      reasons.push(`missing "${part}"`)
      break
    }
  }
  // A base/unparalleled digital card must not match a paper parallel.
  if (/^base$/i.test(key.parallel) && printRunOf(c.name) != null) reasons.push("paper card is numbered, digital base is not a parallel")

  const paperRun = printRunOf(c.name)
  const printRunMatch = paperRun == null ? null : key.digitalMintCap != null && paperRun === key.digitalMintCap
  return { id: c.id, accept: reasons.length === 0, reasons, printRunMatch }
}

export type MatchResult =
  | { status: "matched"; cardId: string; printRunMatch: boolean | null }
  | { status: "ambiguous"; cardIds: string[] }
  | { status: "none"; rejected: CandidateVerdict[] }

/**
 * Exactly one surviving candidate is a match. Two or more stay ambiguous —
 * the human (or a richer feed field, e.g. card number) settles them, never a
 * tie-break heuristic.
 */
export function matchPaperCard(key: PaperKey, candidates: FeedCard[]): MatchResult {
  const verdicts = candidates.map((c) => judgeCandidate(key, c))
  const ok = verdicts.filter((v) => v.accept)
  if (ok.length === 1) return { status: "matched", cardId: ok[0].id, printRunMatch: ok[0].printRunMatch }
  if (ok.length > 1) return { status: "ambiguous", cardIds: ok.map((v) => v.id) }
  return { status: "none", rejected: verdicts }
}

/**
 * Digital vs paper on one card. Returns null unless BOTH sides have a price —
 * an unpriced side is never $0 (timeout-renders-as-a-false-zero), so there is
 * no ratio to show.
 */
export function compareDigitalPaper(digitalUsd: number | null, paperUsd: number | null): { ratio: number; premiumPct: number } | null {
  if (digitalUsd == null || paperUsd == null || !(digitalUsd > 0) || !(paperUsd > 0)) return null
  const ratio = Math.round((digitalUsd / paperUsd) * 1000) / 1000
  return { ratio, premiumPct: Math.round((ratio - 1) * 1000) / 10 }
}
