// lib/pinnacle/atlas-disney.ts
//
// Disney Pinnacle reads from Dapper's ATLAS API (2026-11-18, #218), replacing the
// studio-platform GraphQL that has answered HTTP 530 / "error code: 1033" since
// 11-17 ~4:23 PM PT. disneypinnacle.com itself now calls Atlas.
//
// TRANSPORT — through the database, never a Vercel `fetch`. Atlas's WAF 403s
// Node/undici `fetch` from Vercel (verified 2026-06-16 from iad1; see
// lib/chains/flow/atlas.ts and app/api/cron/topshot-active-listings-ingest) but
// answers Supabase pg_net. So each call is two RPCs:
//   1. `atlas_disney_begin(p_method, p_body)` enqueues the pg_net POST to
//      /public/atlas.v1.<method> (allow-listed methods, product forced to "disney")
//      and returns the request id. pg_net only SENDS once that transaction commits,
//      so the poll must be a SECOND call.
//   2. `atlas_await_response(p_request_id, p_max_ms)` (existing, shared with the
//      Top Shot on-demand lanes) polls net._http_response and returns
//      {ok:true, body} or {ok:false, status, error}.
// Cloudflare challenges ~5–15 % of Atlas calls with an HTML 403 ("Just a
// moment..."); those are retried. Every failure that survives the retries is a
// FAILED READ carrying its HTTP status — never an empty answer.
//
// FIELD MAPPING — measured 2026-11-18 PT against the live catalog:
// `EditionService/SearchEditions` returned 2,970 editions; ALL 2,970 matched an
// existing pinnacle_catalog row on `renderId` = render_id, and on every scalar the
// row holds (edition_id = id, shape_render_id = editionTemplate.renderId,
// character_name = editionTemplate.name, set_name/set_render_id = set.name/renderId,
// variant = parallel, printing, edition_type = editionTemplate.editionType,
// series_name, is_chaser = chaser, color/size/thickness). characters/franchises/
// royalty_codes matched 2,970/2,970 with the parse below (15 were null on both
// sides); effects 2,969 (one edition Dapper now reports as "NONE"), materials 2,970.
// total_minted differs only where an open edition kept minting after Studio's
// last sweep (Atlas numMinted is the live count). The 2 catalog rows Atlas lacks
// are chain-filled Genesis 1/1s (GEN-20CG-ALIN-S0, GEN-20CG-AVTR-S0).
// ⚠ editions[].renderId is the PIN key; set.renderId is SET-level (CLAUDE.md,
// "Disney Pinnacle grain") — never key a catalog row on it.

export const ATLAS_DISNEY_METHODS = [
  "EditionService/SearchEditions",
  "MarketplaceService/SearchMarketplaceTransactions",
  "NFTService/GetNFTs",
] as const
export type AtlasDisneyMethod = (typeof ATLAS_DISNEY_METHODS)[number]

export type AtlasCallResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number | null; error: string }

export type AtlasDisneyCall = (method: AtlasDisneyMethod, body: Record<string, unknown>) => Promise<AtlasCallResult>

export type AtlasRpcDb = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>
}

/** A Cloudflare managed challenge (HTML 403), a rate limit, a 5xx or a poll timeout — worth another try. */
export function isRetryableAtlasFailure(r: { status: number | null; error: string }): boolean {
  if (r.status === 403 || r.status === 429) return true
  if (r.status != null && r.status >= 500) return true
  return r.status == null && /atlas_timeout|timed? ?out/i.test(r.error)
}

/** "atlas SearchEditions HTTP 403 (Cloudflare challenge)" — the status is always in the string. */
export function atlasErrorMessage(method: AtlasDisneyMethod, r: { status: number | null; error: string }): string {
  const short = method.split("/")[1] ?? method
  const challenge = /Just a moment|<!DOCTYPE html/i.test(r.error)
  const detail = challenge ? "Cloudflare challenge" : r.error.replace(/\s+/g, " ").slice(0, 120)
  return `atlas ${short} ${r.status != null ? `HTTP ${r.status}` : "no response"}${detail ? ` (${detail})` : ""}`
}

/**
 * The production Atlas caller: pg_net via `atlas_disney_begin` + `atlas_await_response`.
 * Never throws; a surviving failure comes back as {ok:false, status, error}.
 */
export function dbAtlasDisneyCall(
  db: AtlasRpcDb,
  opts: { maxMs?: number; attempts?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): AtlasDisneyCall {
  const maxMs = opts.maxMs ?? 20_000
  const attempts = Math.max(1, opts.attempts ?? 3)
  const backoffMs = opts.backoffMs ?? 1_500
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  return async (method, body) => {
    let last: { ok: false; status: number | null; error: string } = { ok: false, status: null, error: "not attempted" }
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(backoffMs * i)
      let id: number
      try {
        const begin = await db.rpc("atlas_disney_begin", { p_method: method, p_body: body })
        if (begin.error) return { ok: false, status: null, error: `atlas_disney_begin: ${begin.error.message ?? "failed"}` }
        id = typeof begin.data === "number" ? begin.data : Number(begin.data)
        if (!Number.isFinite(id) || id <= 0) return { ok: false, status: null, error: "atlas_disney_begin returned no request id" }
      } catch (e) {
        return { ok: false, status: null, error: `atlas_disney_begin: ${e instanceof Error ? e.message : String(e)}` }
      }
      let env: Record<string, unknown> | null = null
      try {
        const col = await db.rpc("atlas_await_response", { p_request_id: id, p_max_ms: maxMs })
        if (col.error) {
          last = { ok: false, status: null, error: `atlas_await_response: ${col.error.message ?? "failed"}` }
          continue
        }
        env = col.data && typeof col.data === "object" && !Array.isArray(col.data) ? (col.data as Record<string, unknown>) : null
      } catch (e) {
        last = { ok: false, status: null, error: `atlas_await_response: ${e instanceof Error ? e.message : String(e)}` }
        continue
      }
      if (!env) {
        last = { ok: false, status: null, error: "atlas_await_response returned no envelope" }
        continue
      }
      if (env.ok === true) return { ok: true, body: env.body }
      last = {
        ok: false,
        status: typeof env.status === "number" ? env.status : null,
        error: typeof env.error === "string" ? env.error : "atlas_error",
      }
      if (!isRetryableAtlasFailure(last)) return last
    }
    return last
  }
}

// ── parsing ──────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v)
  return s === "" || s === "null" ? null : s
}

function int(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = parseInt(String(v), 10)
  return Number.isFinite(n) ? n : null
}

/**
 * An Atlas metadata value → string[]. Atlas serialises list metadata two ways:
 * a JSON array string ('["Merida"]') or a comma-joined string
 * ("Mother Gothel,Stabbington Brothers"). JSON elements are kept VERBATIM — Studio
 * stored "Lady " and "Ratatouille " with their trailing space and the character
 * pages key on that text; trimming would rename them. Measured 2,970/2,970.
 */
export function atlasMetaList(v: unknown): string[] | null {
  if (v == null) return null
  if (Array.isArray(v)) {
    const out = v.map(String).filter((s) => s.trim() !== "")
    return out.length ? out : null
  }
  const s = String(v)
  if (s === "" || s === "null") return null
  let parts: string[]
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s)
      parts = Array.isArray(parsed) ? parsed.map(String) : [s]
    } catch {
      parts = [s]
    }
  } else {
    parts = s.split(",")
  }
  const out = parts.filter((p) => p.trim() !== "")
  return out.length ? out : null
}

/** effects / materials: stored as a JSON-list string. A JSON-array value is kept as Dapper sent it. */
export function atlasMetaJsonList(v: unknown): string | null {
  if (v == null) return null
  const s = String(v)
  if (s === "" || s === "null") return null
  if (s.startsWith("[")) {
    try {
      if (Array.isArray(JSON.parse(s))) return s
    } catch {
      // fall through to the comma form
    }
  }
  const l = atlasMetaList(s)
  return l ? JSON.stringify(l) : null
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null)

/**
 * One Atlas `Edition` → a pinnacle_catalog row, the same columns the Studio
 * `buildRow` wrote. `limitedByType` maps an edition-type NAME to its
 * limited_edition flag as the catalog already records it (Atlas carries no such
 * flag); an unknown or ambiguous type writes null, never a guess.
 */
export function atlasEditionToCatalogRow(edition: unknown, nowIso: string, limitedByType: Map<string, boolean | null>) {
  const e = rec(edition)
  if (!e) return null
  const renderId = str(e.renderId)
  const editionId = str(e.id)
  if (!renderId || !editionId) return null
  const tpl = rec(e.editionTemplate)
  const tmd = rec(tpl?.metadata) ?? {}
  const md = rec(e.metadata) ?? {}
  const set = rec(e.set)
  const series = rec(e.series)
  const royaltyCodes = atlasMetaList(tmd.RoyaltyCodes)
  const royaltyCode = royaltyCodes?.[0] ?? null
  const variant = str(e.parallel)
  const printing = int(e.printing)
  const editionType = str(tpl?.editionType)
  return {
    render_id: renderId,
    edition_id: editionId,
    shape_render_id: str(tpl?.renderId),
    character_name: str(tpl?.name),
    set_name: str(set?.name),
    set_render_id: str(set?.renderId),
    variant,
    parallel_type: null,
    printing,
    total_minted: int(e.numMinted),
    edition_type: editionType,
    limited_edition: editionType != null ? (limitedByType.get(editionType) ?? null) : null,
    series_name: str(series?.name),
    royalty_code: royaltyCode,
    royalty_codes: royaltyCodes,
    franchises: atlasMetaList(tmd.Franchises),
    characters: atlasMetaList(tmd.Characters),
    color: str(md.Color),
    effects: atlasMetaJsonList(md.Effects),
    materials: atlasMetaJsonList(md.Materials),
    size: str(md.Size),
    thickness: str(md.Thickness),
    is_chaser: typeof e.chaser === "boolean" ? e.chaser : null,
    legacy_edition_key:
      royaltyCode && variant != null && printing != null ? `${royaltyCode}:${variant}:${printing}` : null,
    thumbnail_url: `/api/public/pinnacle-image/${renderId}`,
    front_anim_url: `https://assets.disneypinnacle.com/render/${renderId}/front_anim.webp`,
    source: "atlas-edition-search",
    updated_at: nowIso,
  }
}

export type AtlasCatalogRow = NonNullable<ReturnType<typeof atlasEditionToCatalogRow>>

/** Dapper's own per-edition low ask, in cents; null when nothing is listed (Atlas sends "0"). */
export function atlasLowAskCents(edition: unknown): number | null {
  const e = rec(edition)
  const n = Number(e?.lowAskCents)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Atlas pagination envelope; `hasMore` is the only completeness signal (totalCount is a lower bound on listings). */
export function atlasPagination(body: unknown): { hasMore: boolean | null; totalCount: number | null } {
  const p = rec(rec(body)?.pagination)
  return {
    hasMore: typeof p?.hasMore === "boolean" ? p.hasMore : p ? false : null,
    totalCount: p && p.totalCount != null && Number.isFinite(Number(p.totalCount)) ? Number(p.totalCount) : null,
  }
}

export type AtlasOpenListing = { uuid: string | null; nft_id: string; edition_id: string; price_cents: number; serial_number: number | null }

/** An OPEN (completed:false) marketplace transaction → listing, or null when unusable. Serial 0 = an open-edition pin (no serial). */
export function atlasOpenListing(tx: unknown): AtlasOpenListing | null {
  const t = rec(tx)
  if (!t || t.completed === true || t.purchased === true) return null
  const nftId = str(t.nftId)
  const editionId = str(t.editionId) ?? str(rec(t.edition)?.id)
  const cents = Number(t.priceCents)
  if (!nftId || !editionId || !Number.isFinite(cents) || cents <= 0) return null
  const serial = int(t.serialNumber)
  return { uuid: str(t.uuid), nft_id: nftId, edition_id: editionId, price_cents: cents, serial_number: serial != null && serial > 0 ? serial : null }
}

/** GetNFTs `nfts[]` entry → {id, serial, render_id}. render_id = the NFT's (= its edition's) renderId. */
export function atlasNftRender(nft: unknown): { id: string; serial: number | null; render_id: string | null } | null {
  const n = rec(nft)
  const id = str(n?.id)
  if (!n || !id) return null
  const serial = int(n.serialNumber)
  return {
    id,
    serial: serial != null && serial > 0 ? serial : null,
    render_id: str(n.renderId) ?? str(rec(n.edition)?.renderId),
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

// ── sweeps ───────────────────────────────────────────────────────────────────

/** Server-side `limit` caps, measured 11-18 (a larger limit is silently clamped). */
export const EDITION_PAGE = 100
export const LISTING_PAGE = 200

export type EditionSweep = {
  editions: unknown[]
  /** Every page answered, the last said hasMore:false, and the distinct count reached totalCount. */
  complete: boolean
  pages: number
  totalCount: number | null
  errors: string[]
}

/**
 * Page `EditionService/SearchEditions` (the server caps `limit` at 100). The first
 * page's totalCount plans the rest, fetched `concurrency` at a time; if the last
 * planned page still says hasMore (the catalog grew mid-sweep) it keeps going.
 * Measured 2026-11-18: 30 pages, 2,970 distinct editions = totalCount, no duplicates.
 */
export async function sweepAtlasEditions(
  call: AtlasDisneyCall,
  opts: { concurrency?: number; maxPages?: number } = {},
): Promise<EditionSweep> {
  const pageSize = EDITION_PAGE // the server caps SearchEditions at 100
  const concurrency = opts.concurrency ?? 4
  const maxPages = opts.maxPages ?? 200
  const method: AtlasDisneyMethod = "EditionService/SearchEditions"
  const req = (offset: number) => ({ product: "disney", limit: pageSize, offset, includeShoebox: true })
  const errors: string[] = []
  const byId = new Map<string, unknown>()
  let pages = 0
  let lastHasMore: boolean | null = null

  const take = (body: unknown) => {
    const list = rec(body)?.editions
    for (const e of Array.isArray(list) ? list : []) {
      const id = str(rec(e)?.id)
      if (id && !byId.has(id)) byId.set(id, e)
    }
    return Array.isArray(list) ? list.length : 0
  }

  const first = await call(method, req(0))
  pages++
  if (!first.ok) {
    return { editions: [], complete: false, pages, totalCount: null, errors: [atlasErrorMessage(method, first)] }
  }
  take(first.body)
  const { totalCount, hasMore } = atlasPagination(first.body)
  lastHasMore = hasMore
  let offset = pageSize
  if (hasMore !== false) {
    const planned = totalCount != null ? Math.ceil(totalCount / pageSize) : 1
    const offsets: number[] = []
    for (let p = 1; p < Math.min(planned, maxPages); p++) offsets.push(p * pageSize)
    const results = await mapPool(offsets, concurrency, (o) => call(method, req(o)))
    pages += results.length
    results.forEach((r, i) => {
      if (!r.ok) errors.push(`offset ${offsets[i]}: ${atlasErrorMessage(method, r)}`)
      else {
        take(r.body)
        if (i === results.length - 1) lastHasMore = atlasPagination(r.body).hasMore
      }
    })
    offset = (offsets.length + 1) * pageSize
    // Grew mid-sweep (or no totalCount): continue one page at a time.
    while (errors.length === 0 && lastHasMore === true && pages < maxPages) {
      const r = await call(method, req(offset))
      pages++
      if (!r.ok) {
        errors.push(`offset ${offset}: ${atlasErrorMessage(method, r)}`)
        break
      }
      const n = take(r.body)
      lastHasMore = atlasPagination(r.body).hasMore
      offset += pageSize
      if (n === 0) break
    }
  }
  if (lastHasMore === true && errors.length === 0) errors.push(`editions sweep stopped at the ${maxPages}-page guard with more to read`)
  const editions = [...byId.values()]
  const complete = errors.length === 0 && lastHasMore !== true && (totalCount == null || editions.length >= totalCount)
  if (errors.length === 0 && !complete) {
    errors.push(`editions sweep incomplete: ${editions.length} distinct of ${totalCount} reported`)
  }
  return { editions, complete, pages, totalCount, errors }
}

export type ListingSweep = {
  listings: AtlasOpenListing[]
  /** Rows the pages carried, before de-duplication on the listing uuid. */
  rowsSeen: number
  /** Rows whose uuid an earlier page already returned (offset paging over a moving set). */
  duplicates: number
  /** Rows that were not a usable open listing (no nft/edition id, non-positive price, completed). */
  unusable: number
  complete: boolean
  pages: number
  errors: string[]
}

/**
 * Page every OPEN Pinnacle listing via `MarketplaceService/SearchMarketplaceTransactions`
 * (completed:false; the server caps `limit` at 200). Sorted LISTED_AT ASC so a new
 * listing lands at the END instead of shifting every later page — measured 11-18
 * over the full market: LISTED_AT ASC 9,291 rows = 9,291 distinct listings; PRICE
 * ASC 9,291 rows but only 9,015 distinct (ties reshuffle between pages). Complete only if
 * every page answered and the sweep reached a short / hasMore:false page.
 * ⚠ Atlas returns only listings from the last ~30 days (oldest seen 11-18: 29.9 d) —
 * Dapper's listing expiry — where Studio's set also carried older ones.
 */
export async function sweepAtlasOpenListings(
  call: AtlasDisneyCall,
  opts: { concurrency?: number; maxPages?: number } = {},
): Promise<ListingSweep> {
  const pageSize = LISTING_PAGE // the server caps SearchMarketplaceTransactions at 200
  const concurrency = opts.concurrency ?? 4
  const maxPages = opts.maxPages ?? 200
  const method: AtlasDisneyMethod = "MarketplaceService/SearchMarketplaceTransactions"
  const errors: string[] = []
  const seen = new Map<string, AtlasOpenListing>()
  let rowsSeen = 0
  let duplicates = 0
  let unusable = 0
  let pages = 0
  let reachedEnd = false
  let nextOffset = 0
  while (!reachedEnd && errors.length === 0 && pages < maxPages) {
    const wave: number[] = []
    for (let i = 0; i < concurrency && pages + wave.length < maxPages; i++) wave.push(nextOffset + i * pageSize)
    nextOffset += wave.length * pageSize
    const results = await mapPool(wave, concurrency, (o) =>
      call(method, { product: "disney", completed: false, sortByOption: "LISTED_AT", sortByDirection: "ASC", limit: pageSize, offset: o }),
    )
    pages += results.length
    results.forEach((r, i) => {
      if (reachedEnd) return
      if (!r.ok) {
        errors.push(`offset ${wave[i]}: ${atlasErrorMessage(method, r)}`)
        return
      }
      const txs = rec(r.body)?.transactions
      const list = Array.isArray(txs) ? txs : []
      rowsSeen += list.length
      for (const tx of list) {
        const l = atlasOpenListing(tx)
        if (!l) {
          unusable++
          continue
        }
        const key = l.uuid ?? `${l.nft_id}:${l.price_cents}`
        if (seen.has(key)) duplicates++
        else seen.set(key, l)
      }
      if (list.length < pageSize || atlasPagination(r.body).hasMore === false) reachedEnd = true
    })
  }
  if (!reachedEnd && errors.length === 0) errors.push(`listing sweep stopped at the ${maxPages}-page guard with more to read`)
  const listings = [...seen.values()]
  return { listings, rowsSeen, duplicates, unusable, complete: reachedEnd && errors.length === 0, pages, errors }
}
