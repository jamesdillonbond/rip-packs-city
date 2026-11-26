// lib/panini/brand-line.ts
//
// The Panini BRAND LINE a product belongs to (2026-11-26): Prizm, Select, Donruss Optic, Mosaic … — the name
// collectors shop by across leagues ("show me the Prizm"). Read from the product's own name against Panini's
// line names; a product whose name carries none of them has NO line (null), never a guessed one.
// Client-safe (no DB imports).

/** Longest / most specific first, so "Donruss Optic" is not read as a bare "Donruss". */
const LINES: ReadonlyArray<[RegExp, string]> = [
  [/\bDonruss Optic\b/i, "Donruss Optic"],
  [/\bCourt Kings\b/i, "Court Kings"],
  [/\bBest of\b/i, "Best of"],
  [/\bPrizm\b/i, "Prizm"],
  [/\bSelect\b/i, "Select"],
  [/\bMosaic\b/i, "Mosaic"],
  [/\bHoops\b/i, "Hoops"],
  [/\bFlawless\b/i, "Flawless"],
  [/\bInstant\b/i, "Instant"],
  [/\bSilhouette\b/i, "Silhouette"],
  [/\bSpectra\b/i, "Spectra"],
  [/\bObsidian\b/i, "Obsidian"],
  [/\bOrigins\b/i, "Origins"],
  [/\bDonruss\b/i, "Donruss"],
]

export function paniniBrandLine(productName: string | null | undefined): string | null {
  const name = productName ?? ""
  for (const [re, line] of LINES) if (re.test(name)) return line
  return null
}

/** Lines present among products, most products first; `null` (no line) is not an option. */
export function brandLineOptions(names: ReadonlyArray<string>): { line: string; products: number }[] {
  const by = new Map<string, number>()
  for (const n of names) {
    const line = paniniBrandLine(n)
    if (line) by.set(line, (by.get(line) ?? 0) + 1)
  }
  return [...by.entries()].map(([line, products]) => ({ line, products })).sort((a, b) => b.products - a.products || a.line.localeCompare(b.line))
}
