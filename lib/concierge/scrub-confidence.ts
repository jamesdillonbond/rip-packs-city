// lib/concierge/scrub-confidence.ts — FMV confidence never reaches the model
// (2026-10-24; Trevor's 10-18 rule: confidence is internal only).
//
// A prompt rule alone did not hold: tool results handed the model
// `fmv_confidence: "LOW"`, `confidence: "STALE"` and the like, and real answers
// said "LOW confidence — directional only", "STALE" and rendered a "Confidence"
// column (support_conversations 10-18 and 10-24). Every tool result now passes
// through this scrubber on its way into the conversation: a confidence TIER
// becomes `pricing_basis`, a plain-language statement of what the price rests on
// (which the bot may say), and any other confidence-keyed value is dropped.
// The API field itself is unchanged for the site's own internal use.

const BASIS: Record<string, string> = {
  HIGH: "priced from plenty of recent sales",
  MEDIUM: "priced from several recent sales",
  LOW: "priced from very few sales — treat as rough",
  ASK_ONLY: "estimated from current asking prices, not sales",
  SALES_ONLY: "priced from sales, with no current ask to compare",
  STALE: "based on older sales — may be out of date",
  NO_DATA: "no price data",
}

const CONF_KEY = /confidence/i

export function basisFor(tier: unknown): string | null {
  if (typeof tier !== "string") return null
  return BASIS[tier.trim().toUpperCase()] ?? null
}

function renameKey(key: string): string {
  // fmv_confidence → fmv_pricing_basis, confidence → pricing_basis
  const k = key.replace(/confidence/i, "pricing_basis")
  return k
}

/**
 * 2026-11-12: a price that a rule moved AFTER the model computed it (offer pull, sales / comparables
 * cap, offer floor) is not "estimated from current asking prices" any more — the live concierge said
 * exactly that about a $6.18 price sitting between a $6.00 offer and a $12.50 ask, with the rule's
 * sentence available in a sibling `price_adjustments` field it did not use. So the basis sentence
 * itself now carries the rule: when the row has a non-empty `price_adjustments` list, the basis is
 * where the price STARTED plus what was done to it.
 */
const STARTED: Record<string, string> = {
  ASK_ONLY: "no recent sales to price from: started from current asking prices",
  LOW: "very few sales: started from those",
  STALE: "only older sales: started from those",
}

export function adjustedBasisFor(tier: unknown, adjustments: unknown): string | null {
  const basis = basisFor(tier)
  if (!basis) return null
  const notes = Array.isArray(adjustments) ? adjustments.filter((n): n is string => typeof n === "string" && n.length > 0) : []
  if (notes.length === 0) return basis
  const start = STARTED[String(tier).trim().toUpperCase()] ?? basis
  return `${start}, then ${notes.join(", then ")}`
}

function walk(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(walk)
  if (!v || typeof v !== "object") return v
  const out: Record<string, unknown> = {}
  const adjustments = (v as Record<string, unknown>).price_adjustments
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (CONF_KEY.test(k)) {
      const basis = adjustedBasisFor(val, adjustments)
      if (basis) out[renameKey(k)] = basis
      else if (typeof val === "boolean" && /low/i.test(k)) out[k.replace(/low_?confidence_?/i, "thin_pricing_")] = val
      // numbers, objects (per-tier counts), unknown strings: dropped
      continue
    }
    out[k] = walk(val)
  }
  return out
}

/** Takes a tool's JSON string result; returns it with confidence tiers removed. Non-JSON passes through. */
export function scrubConfidence(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  return JSON.stringify(walk(parsed))
}
