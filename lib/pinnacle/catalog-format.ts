// lib/pinnacle/catalog-format.ts
//
// Pure catalog-field formatters for the Disney Pinnacle moment page
// (app/pinnacle/moment/[id]/page.tsx). Lifted inline so the jsonb-array parse
// path is unit-tested. Byte-identical to the page's inline copy; the page
// imports this.

import { dedupeLabelParts } from "@/lib/format"

// materials/effects come back as jsonb/text arrays (e.g. '["GOLD"]',
// '["LED GLITCH"]'). Render them as plain joined text rather than raw JSON.
// A malformed JSON string is shown as-is (never throws); a plain (non-"[")
// string passes through; genuine repeats are de-duplicated (first occurrence
// wins, order preserved) so ["LED MARQUEE","LED MARQUEE"] renders once.
export function fmtList(v: string | string[] | null | undefined): string {
  if (v == null) return "—"
  let arr: unknown = v
  if (typeof v === "string") {
    const s = v.trim()
    if (s === "") return "—"
    if (s.startsWith("[")) {
      try { arr = JSON.parse(s) } catch { return s }
    } else {
      return s
    }
  }
  if (Array.isArray(arr)) {
    const cleaned = dedupeLabelParts(arr.map((x) => String(x)))
    return cleaned.length ? cleaned.join(", ") : "—"
  }
  return String(arr)
}
