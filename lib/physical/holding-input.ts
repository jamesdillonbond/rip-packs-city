/**
 * Validates a "add a card I own" request (prototype). Mirrors the CHECKs in
 * docs/physical/physical-holdings-draft.sql so a bad row is refused with a
 * plain message before it reaches the database.
 */
export type HoldingInput = {
  cardId: string
  grader: "psa" | "bgs" | "cgc" | "sgc" | "raw"
  grade: string
  certNumber: string | null
  rawCondition: "mint" | "near_mint" | "excellent" | "very_good" | "poor" | null
  quantity: number
  costBasisUsd: number | null
  acquiredOn: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GRADERS = new Set(["psa", "bgs", "cgc", "sgc", "raw"])
const CONDITIONS = new Set(["mint", "near_mint", "excellent", "very_good", "poor"])
const GRADE = /^(10|[1-9](\.5)?|1\.5)$/

export function parseHoldingInput(body: unknown): { ok: true; value: HoldingInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const cardId = typeof b.cardId === "string" ? b.cardId : ""
  if (!UUID.test(cardId)) return { ok: false, error: "Pick the card from the search results." }
  const grader = typeof b.grader === "string" ? b.grader.toLowerCase() : ""
  if (!GRADERS.has(grader)) return { ok: false, error: "Grader must be PSA, BGS, CGC, SGC or raw." }

  const quantity = b.quantity === undefined ? 1 : Number(b.quantity)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return { ok: false, error: "Quantity must be a whole number from 1 to 999." }

  let cost: number | null = null
  if (b.costBasisUsd !== undefined && b.costBasisUsd !== null && b.costBasisUsd !== "") {
    cost = Number(b.costBasisUsd)
    if (!Number.isFinite(cost) || cost < 0 || cost > 10_000_000) return { ok: false, error: "Cost must be a dollar amount." }
    cost = Math.round(cost * 100) / 100
  }
  const acquiredOn = typeof b.acquiredOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.acquiredOn) ? b.acquiredOn : null

  if (grader === "raw") {
    const cond = typeof b.rawCondition === "string" ? b.rawCondition : ""
    if (!CONDITIONS.has(cond)) return { ok: false, error: "Pick a condition for a raw card." }
    if (b.certNumber) return { ok: false, error: "A raw card has no cert number." }
    return { ok: true, value: { cardId, grader: "raw", grade: "raw", certNumber: null, rawCondition: cond as HoldingInput["rawCondition"], quantity, costBasisUsd: cost, acquiredOn } }
  }

  const grade = String(b.grade ?? "").trim()
  if (!GRADE.test(grade)) return { ok: false, error: "Grade must be between 1 and 10." }
  const cert = typeof b.certNumber === "string" ? b.certNumber.replace(/[\s-]/g, "") : ""
  if (!/^\d{6,12}$/.test(cert)) return { ok: false, error: "Enter the cert number printed on the slab." }
  if (quantity !== 1) return { ok: false, error: "A graded slab is one card." }
  return { ok: true, value: { cardId, grader: grader as HoldingInput["grader"], grade, certNumber: cert, rawCondition: null, quantity: 1, costBasisUsd: cost, acquiredOn } }
}
