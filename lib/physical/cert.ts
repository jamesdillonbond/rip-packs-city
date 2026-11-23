/**
 * Physical cards — grader + cert input parsing and the HobbyCardIndex cert
 * mapper (prototype, NOT wired; no keys; nothing calls a network).
 *
 * Input is an IDENTIFIER, like every other RPC input (rpc-no-wallet-signin):
 * the collector types the grader and cert number printed on the slab.
 *
 * Response shape follows HCI's published docs (GET /api/v1/certs/:grader/:cert,
 * read 2026-11-22): `cert` {grader, certNumber, grade, player, year,
 * cardNumber, population?}, `card` {id, name, prices}, `slab` {grader, grade,
 * certVerified, priceAtGrade, verifyUrl, …}. PSA's own public API documents
 * only the GetByCertNumber path and an IsValidRequest flag, so it is used as a
 * verification fallback, not as the identity source.
 */
import type { Grader } from "./valuation-range"

export type CertInput = { grader: Exclude<Grader, "raw">; certNumber: string }

const DIGITS: Record<CertInput["grader"], RegExp> = {
  // Lengths are deliberately loose bounds — graders have changed formats over
  // the years; reject only what cannot be a cert.
  psa: /^\d{6,10}$/,
  bgs: /^\d{6,12}$/,
  cgc: /^\d{6,12}$/,
  sgc: /^\d{6,10}$/,
}

/**
 * Accepts "PSA 12345678", "psa#12345678", "12345678" with an explicit grader,
 * and strips spaces, dashes and a leading "#".
 */
export function parseCertInput(raw: string, graderHint?: string): CertInput | null {
  const s = raw.trim().toLowerCase()
  const m = s.match(/^(psa|bgs|beckett|cgc|sgc)?\s*[#:\-]?\s*([\d\s\-]+)$/)
  if (!m) return null
  const graderWord = (m[1] ?? graderHint ?? "").toLowerCase()
  const grader = (graderWord === "beckett" ? "bgs" : graderWord) as CertInput["grader"]
  if (!(grader in DIGITS)) return null
  const certNumber = m[2].replace(/[\s\-]/g, "")
  if (!DIGITS[grader].test(certNumber)) return null
  return { grader, certNumber }
}

export type ResolvedSlab = {
  grader: CertInput["grader"]
  certNumber: string
  grade: string
  player: string | null
  year: number | null
  cardNumber: string | null
  cardId: string | null // HCI card id — the price key
  cardName: string | null
  certVerified: boolean
  verifyUrl: string | null
}

/** Maps an HCI cert response; returns null if the cert did not resolve. */
export function mapHciCert(body: unknown, input: CertInput): ResolvedSlab | null {
  const b = body as {
    cert?: { grade?: string | number; player?: string; year?: number | string; cardNumber?: string }
    card?: { id?: string | number; name?: string }
    slab?: { certVerified?: boolean; verifyUrl?: string; grade?: string | number }
  }
  const grade = b?.slab?.grade ?? b?.cert?.grade
  if (grade == null) return null
  const yr = Number(b.cert?.year)
  return {
    grader: input.grader,
    certNumber: input.certNumber,
    grade: String(grade),
    player: b.cert?.player ?? null,
    year: Number.isFinite(yr) ? yr : null,
    cardNumber: b.cert?.cardNumber ?? null,
    cardId: b.card?.id != null ? String(b.card.id) : null,
    cardName: b.card?.name ?? null,
    certVerified: b.slab?.certVerified === true,
    verifyUrl: b.slab?.verifyUrl ?? null,
  }
}

/** PSA public API: the only documented success signal. */
export function psaLookupSucceeded(body: unknown): boolean {
  return (body as { IsValidRequest?: boolean })?.IsValidRequest === true
}
