/**
 * HobbyCardIndex API client (prototype, NOT wired; no key exists).
 *
 * Endpoints and fields follow HCI's developer docs (read 2026-11-22):
 *   GET /api/v1/prices/search?q=&category=&set=&sort=   — card search (requests)
 *   GET /api/v1/prices/:cardId                          — prices by grade (requests)
 *   GET /api/v1/prices/:cardId/sales?days=&sample=      — sold sales (ONE sold-sale lookup per call)
 *   GET /api/v1/certs/:grader/:certNumber               — cert lookup (cert allowance, 1/s per key)
 *   GET /api/v1/sets?category=                          — set list (requests)
 * Auth: X-API-Key. 429 RATE_LIMITED; REQUIRES_COMMERCIAL_LICENSE on /sales
 * without a commercial plan.
 *
 * Terms that shape callers (not this file): data may be stored only while a
 * commercial plan is active and must be deleted within 30 days of it ending;
 * no standalone sales database; one link to hobbycardindex.com on the site.
 */
import type { Grader, PhysicalSale, SaleType } from "./valuation-range"
import type { CertInput } from "./cert"

export const HCI_BASE = "https://hobbycardindex.com/api/v1"

export type HciError = { ok: false; status: number; code: string | null }
export type HciOk<T> = { ok: true; data: T }
export type HciResult<T> = HciOk<T> | HciError

export type HciCardSummary = {
  id: string
  name: string
  year: number | null
  setName: string | null
  playerName: string | null
  category: string | null
}

export class HciClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = HCI_BASE,
  ) {}

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<HciResult<T>> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v))
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ""}`
    let res: Response
    try {
      res = await this.fetchImpl(url, { headers: { "X-API-Key": this.apiKey, Accept: "application/json" }, cache: "no-store" })
    } catch {
      return { ok: false, status: 0, code: "NETWORK" }
    }
    if (!res.ok) {
      let code: string | null = null
      try {
        const j = (await res.json()) as { error?: { code?: string } | string; code?: string }
        code = typeof j.error === "string" ? j.error : (j.error?.code ?? j.code ?? null)
      } catch {
        /* body not JSON */
      }
      return { ok: false, status: res.status, code }
    }
    return { ok: true, data: (await res.json()) as T }
  }

  async searchCards(q: string, category?: string): Promise<HciResult<HciCardSummary[]>> {
    const r = await this.get<{ results?: unknown[]; cards?: unknown[] }>("/prices/search", { q, category })
    if (!r.ok) return r
    const rows = (r.data.results ?? r.data.cards ?? []) as Record<string, unknown>[]
    return { ok: true, data: rows.map(mapCardSummary).filter((c): c is HciCardSummary => c !== null) }
  }

  async sales(cardId: string, days = 90): Promise<HciResult<PhysicalSale[]>> {
    const r = await this.get<{ sales?: unknown[] }>(`/prices/${encodeURIComponent(cardId)}/sales`, { days, sample: "latest" })
    if (!r.ok) return r
    return { ok: true, data: mapHciSales(r.data.sales ?? []) }
  }

  async cert(input: CertInput): Promise<HciResult<unknown>> {
    return this.get(`/certs/${input.grader}/${encodeURIComponent(input.certNumber)}`)
  }
}

function mapCardSummary(c: Record<string, unknown>): HciCardSummary | null {
  if (c.id == null || typeof c.name !== "string") return null
  const year = Number(c.year)
  return {
    id: String(c.id),
    name: c.name,
    year: Number.isFinite(year) ? year : null,
    setName: typeof c.setName === "string" ? c.setName : null,
    playerName: typeof c.playerName === "string" ? c.playerName : null,
    category: typeof c.category === "string" ? c.category : null,
  }
}

const GRADERS: Record<string, Grader> = { psa: "psa", bgs: "bgs", beckett: "bgs", cgc: "cgc", sgc: "sgc" }
const SALE_TYPES = new Set(["auction", "buy_it_now", "best_offer"])

/**
 * Maps HCI sale records into the valuation input. A record whose grader cannot
 * be named is DROPPED, not guessed — guessing would borrow across graders.
 * No grading company + no grade = raw.
 */
export function mapHciSales(rows: unknown[]): PhysicalSale[] {
  const out: PhysicalSale[] = []
  for (const raw of rows) {
    const s = raw as Record<string, unknown>
    const price = Number(s.price)
    const soldAt = typeof s.soldAt === "string" ? s.soldAt : null
    if (!soldAt || !Number.isFinite(Date.parse(soldAt)) || !Number.isFinite(price)) continue
    const company = typeof s.gradingCompany === "string" ? s.gradingCompany.trim().toLowerCase() : ""
    const gradeRaw = s.grade == null ? "" : String(s.grade).trim()
    let grader: Grader
    let grade: string
    if (!company && (!gradeRaw || /^raw|ungraded$/i.test(gradeRaw))) {
      grader = "raw"
      grade = "raw"
    } else if (GRADERS[company] && gradeRaw) {
      grader = GRADERS[company]
      grade = gradeRaw.replace(/^(psa|bgs|cgc|sgc)\s*/i, "")
    } else {
      continue
    }
    const st = typeof s.saleType === "string" && SALE_TYPES.has(s.saleType) ? (s.saleType as SaleType) : null
    const ask = s.askingPrice == null ? null : Number(s.askingPrice)
    out.push({
      soldAt,
      price,
      grader,
      grade,
      saleType: st,
      askingPrice: ask != null && Number.isFinite(ask) ? ask : null,
      source: typeof s.source === "string" ? s.source : null,
      url: typeof s.url === "string" ? s.url : null,
    })
  }
  return out
}
