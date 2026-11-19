// Dapper Atlas DistributionService client for the supply-weighted pack-EV writers
// (compute-allday-pack-ev, compute-golazos-pack-ev, compute-pinnacle-pack-ev).
//
// WHY (2026-11-18 PT). The Studio Platform GraphQL these three read
// (api.production.studio-platform.dapperlabs.com/graphql, searchDistributions)
// has answered HTTP 530 / "error code: 1033" since 11-17 4:23 PM PT. Dapper's own
// sites now call only Atlas: Connect-RPC, JSON bodies, anonymous on
// POST https://api.production.atlas.dapperlabs.com/public/atlas.v1.<Service>/<Method>
// with {"product": "nba"|"nfl"|"laliga"|"disney", ...camelCase fields}.
//
// FIELD MAP (Studio searchDistributions node → Atlas), measured 11-18 PT:
//   uuid, id, title       → SearchDistributions.distributions[].uuid / id / title
//                           (dist 235 "Jornadas 1-9": same uuid 262cbbfb-… in both)
//   numberOfPackSlots     → numberOfPackSlots   (int64 → JSON STRING, e.g. "4")
//   totalSupply           → totalSupply         (int64 STRING; OMITTED on some live
//   availableSupply       → availableSupply      draws, e.g. disney 8923 — unknown, not 0)
//                           ⚠ SAME NAME, NOT PROVEN SAME MEANING. Joined on uuid to our
//                           latest Studio-written pack_ev_history rows (11-18): 160 of
//                           257 total_unopened equal Atlas availableSupply exactly; 97
//                           differ (Golazos 219: Atlas 22,283 vs Studio 20,566; Pinnacle
//                           6563: Atlas 0 vs Studio 121). Every differing sample checked
//                           had a Studio value FROZEN for 40 days, and Atlas agrees with
//                           its own GetDistributionContentSummary / PackOdds (6563:
//                           unopenedCount 0, remainingPackCount 0). Read Atlas as the
//                           live figure; expect depletion_pct to MOVE on deploy.
//   price { value }       → price               (a JSON NUMBER in dollars, 4.99)
//   editionIds            → NOT on Distribution. GetDistributionEditions
//                           {product, distributionId, limit<=100, offset} returns one
//                           row per pool edition (editionId, originalCount,
//                           remainingCount, edition{…}) + totalCount. Without
//                           hideOpened it returns the FULL pool: nfl 7148 → 616 rows
//                           = our 616-row Studio pool; disney 8542 → 53 = the 53
//                           Studio editionIds in pack_distributions.metadata.
//                           ⚠ For product "laliga" it returns {editions:[], totalCount:"0"}
//                           for every distribution probed (219, 234, 235, 238), and
//                           GetDistributionPackOdds / GetDistributionsByEdition are
//                           empty for laliga too. Atlas carries NO Golazos pool.
//   packOdds              → was selected but never consumed by any of the three.
//
// TRANSPORT. Cloudflare in front of Atlas challenges a share of calls with an
// HTML 403 "Just a moment…" and is BURST-SENSITIVE (a 60-request burst 403'd every
// lane for ~4 min, apis-and-cadence.md). So: one request at a time, a fixed gap
// between requests, and a challenge is retried with backoff. Every failure carries
// "HTTP <status>" in its message. A walk that cannot complete returns a FAILURE,
// never the pages it did get: a partial pool or a partial distribution list is
// not a fact (CLAUDE.md "Honesty": a PAGED read that breaks on error).
//
// Pure apart from the injected fetch/sleep, so vitest pins the parsing
// (__tests__/edge-atlas-distributions.test.ts) and the Deno harness can drive it.

export type AtlasProduct = "nba" | "nfl" | "laliga" | "disney"

export const ATLAS_BASE = "https://api.production.atlas.dapperlabs.com/public/atlas.v1."

/** Mirrors public.atlas_market_headers(text) — the header set the DB lanes use and get 200s with. */
export function atlasHeaders(product: AtlasProduct): Record<string, string> {
  const site = product === "nfl" ? "https://nflallday.com" : "https://nbatopshot.com"
  return {
    "content-type": "application/json",
    "connect-protocol-version": "1",
    "origin": site,
    "referer": `${site}/`,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  }
}

export interface AtlasDeps {
  fetchFn: typeof fetch
  sleep: (ms: number) => Promise<void>
  /** Pause before every request after the first one of a walk. */
  gapMs: number
  /** Backoff before each retry of a Cloudflare challenge (length = retries). */
  challengeBackoffMs: number[]
  /** Backoff before each retry of a 429 / 5xx / transport error (length = retries). */
  transientBackoffMs: number[]
  timeoutMs: number
}

export const DEFAULT_ATLAS_DEPS: Omit<AtlasDeps, "fetchFn" | "sleep"> = {
  gapMs: 300,
  challengeBackoffMs: [2000, 5000, 10000],
  transientBackoffMs: [1000],
  timeoutMs: 25000,
}

export function defaultAtlasDeps(): AtlasDeps {
  return {
    ...DEFAULT_ATLAS_DEPS,
    fetchFn: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

export type AtlasOk<T> = { ok: true; data: T; attempts: number }
export type AtlasFail = { ok: false; error: string; status: number | null; attempts: number }
export type AtlasResult<T> = AtlasOk<T> | AtlasFail

/** Cloudflare's managed challenge: an HTML 403 ("Just a moment..."), never a Connect JSON error. */
export function isCloudflareChallenge(status: number, body: string): boolean {
  if (status !== 403) return false
  const head = body.slice(0, 4000)
  return /just a moment/i.test(head) || /challenge-platform|_cf_chl_opt|cf-chl/i.test(head)
}

/** Connect error envelope {code, message} → "not_found: distribution not found". */
function connectErrorText(body: string): string {
  try {
    const j = JSON.parse(body)
    if (j && typeof j === "object" && typeof j.code === "string") {
      return `${j.code}${typeof j.message === "string" ? `: ${j.message}` : ""}`
    }
  } catch {
    // not JSON
  }
  return body.trim().startsWith("<") ? "html body" : body.slice(0, 120).replace(/\s+/g, " ")
}

/**
 * One Atlas call. Retries a Cloudflare challenge (HTML 403) and 429/5xx/transport
 * errors on their own backoff schedules; never retries a Connect error (404
 * not_found, 400 invalid_argument …), which would answer the same way again.
 */
export async function atlasCall<T = unknown>(
  service: string,
  method: string,
  product: AtlasProduct,
  body: Record<string, unknown>,
  deps: AtlasDeps,
): Promise<AtlasResult<T>> {
  const url = `${ATLAS_BASE}${service}/${method}`
  let attempts = 0
  let challenges = 0
  let transients = 0
  for (;;) {
    attempts++
    let status: number | null = null
    let text = ""
    let transportError: string | null = null
    try {
      const res = await deps.fetchFn(url, {
        method: "POST",
        headers: atlasHeaders(product),
        body: JSON.stringify({ product, ...body }),
        signal: AbortSignal.timeout(deps.timeoutMs),
      })
      status = res.status
      text = await res.text()
    } catch (e) {
      transportError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }

    if (transportError != null) {
      if (transients < deps.transientBackoffMs.length) {
        await deps.sleep(deps.transientBackoffMs[transients++])
        continue
      }
      return { ok: false, error: `${method}: transport error (${transportError.slice(0, 120)}) after ${attempts} attempt(s)`, status: null, attempts }
    }

    const s = status as number
    if (s >= 200 && s < 300) {
      try {
        return { ok: true, data: JSON.parse(text) as T, attempts }
      } catch {
        return { ok: false, error: `${method}: HTTP ${s} with a non-JSON body`, status: s, attempts }
      }
    }
    if (isCloudflareChallenge(s, text)) {
      if (challenges < deps.challengeBackoffMs.length) {
        await deps.sleep(deps.challengeBackoffMs[challenges++])
        continue
      }
      return { ok: false, error: `${method}: HTTP 403 (cloudflare challenge) after ${attempts} attempt(s)`, status: 403, attempts }
    }
    if (s === 429 || s >= 500) {
      if (transients < deps.transientBackoffMs.length) {
        await deps.sleep(deps.transientBackoffMs[transients++])
        continue
      }
    }
    return { ok: false, error: `${method}: HTTP ${s} (${connectErrorText(text)}) after ${attempts} attempt(s)`, status: s, attempts }
  }
}

// ── parsing ──────────────────────────────────────────────────────────────────

/**
 * Connect/protojson emits int64 as a decimal STRING and int32/double as a number.
 * Absent / non-numeric → null (unknown), NEVER 0.
 */
export function atlasNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v)
  return null
}

/** The fields the three writers consume — the Studio searchDistributions node, re-sourced. */
export interface AtlasDist {
  uuid: string
  /** Distribution id as Atlas sends it (a decimal string, e.g. "235"). */
  id: string
  title: string | null
  numberOfPackSlots: number | null
  totalSupply: number | null
  availableSupply: number | null
  /** Retail price in DOLLARS; null when Atlas omitted it (a reward pack sends 0 explicitly). */
  price: number | null
}

/** One SearchDistributions row → AtlasDist, or null when it has no uuid/id (unusable). */
export function parseAtlasDistribution(raw: unknown): AtlasDist | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const uuid = typeof r.uuid === "string" && r.uuid !== "" ? r.uuid : null
  const idNum = atlasNum(r.id)
  if (!uuid || idNum == null || !Number.isInteger(idNum)) return null
  return {
    uuid,
    id: String(idNum),
    title: typeof r.title === "string" ? r.title : null,
    numberOfPackSlots: atlasNum(r.numberOfPackSlots),
    totalSupply: atlasNum(r.totalSupply),
    availableSupply: atlasNum(r.availableSupply),
    price: atlasNum(r.price),
  }
}

export interface DistPage {
  dists: AtlasDist[]
  /** Rows Atlas returned that had no uuid/id — counted, never silently dropped. */
  malformed: number
  /** Raw row count of this page (dists + malformed). */
  rawCount: number
  totalCount: number
}

/** A SearchDistributions response → page, or an error string when the envelope is unreadable. */
export function parseSearchDistributionsPage(json: unknown): DistPage | string {
  if (!json || typeof json !== "object") return "SearchDistributions: response is not an object"
  const j = json as Record<string, unknown>
  if (!Array.isArray(j.distributions)) return "SearchDistributions: response has no distributions array"
  const pg = (j.pagination ?? null) as Record<string, unknown> | null
  const totalCount = atlasNum(pg?.totalCount)
  if (totalCount == null) return "SearchDistributions: response has no pagination.totalCount"
  const dists: AtlasDist[] = []
  let malformed = 0
  for (const row of j.distributions) {
    const d = parseAtlasDistribution(row)
    if (d) dists.push(d)
    else malformed++
  }
  return { dists, malformed, rawCount: j.distributions.length, totalCount }
}

export interface EditionsPage {
  editionIds: string[]
  /** Rows with no readable editionId. */
  malformed: number
  rawCount: number
  totalCount: number
}

/** A GetDistributionEditions response → page of edition ids (strings, as Atlas sends them). */
export function parseDistributionEditionsPage(json: unknown): EditionsPage | string {
  if (!json || typeof json !== "object") return "GetDistributionEditions: response is not an object"
  const j = json as Record<string, unknown>
  if (!Array.isArray(j.editions)) return "GetDistributionEditions: response has no editions array"
  const totalCount = atlasNum(j.totalCount)
  if (totalCount == null) return "GetDistributionEditions: response has no totalCount"
  const editionIds: string[] = []
  let malformed = 0
  for (const row of j.editions) {
    const r = (row ?? {}) as Record<string, unknown>
    const ed = (r.edition ?? {}) as Record<string, unknown>
    const id = atlasNum(r.editionId) ?? atlasNum(ed.id)
    if (id == null || !Number.isInteger(id)) malformed++
    else editionIds.push(String(id))
  }
  return { editionIds, malformed, rawCount: j.editions.length, totalCount }
}

// ── walks ────────────────────────────────────────────────────────────────────

export type WalkFail = { ok: false; error: string; status: number | null; requests: number }

/** One SearchDistributions page at (offset, limit). The caller owns the cursor. */
export async function searchDistributionsPage(
  product: AtlasProduct,
  offset: number,
  limit: number,
  deps: AtlasDeps,
): Promise<({ ok: true; requests: number } & DistPage) | WalkFail> {
  const r = await atlasCall("DistributionService", "SearchDistributions", product, { limit, offset }, deps)
  if (!r.ok) return { ok: false, error: r.error, status: r.status, requests: r.attempts }
  const page = parseSearchDistributionsPage(r.data)
  if (typeof page === "string") return { ok: false, error: page, status: 200, requests: r.attempts }
  return { ok: true, requests: r.attempts, ...page }
}

/**
 * Every distribution of a product, walking offset pages until totalCount. All or
 * nothing: a failed page, a short page before totalCount, or a page cap fails the
 * whole walk (a partial list is not the list).
 */
export async function searchAllDistributions(
  product: AtlasProduct,
  deps: AtlasDeps,
  opts: { pageLimit?: number; maxPages?: number } = {},
): Promise<({ ok: true; dists: AtlasDist[]; malformed: number; totalCount: number; pages: number; requests: number }) | WalkFail> {
  const limit = opts.pageLimit ?? 100
  const maxPages = opts.maxPages ?? 20
  const dists: AtlasDist[] = []
  let malformed = 0
  let requests = 0
  let totalCount: number | null = null
  let pagesFetched = 0
  let offset = 0
  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      return { ok: false, error: `SearchDistributions: page cap ${maxPages} reached at offset ${offset} of ${totalCount}`, status: null, requests }
    }
    if (page > 0) await deps.sleep(deps.gapMs)
    const p = await searchDistributionsPage(product, offset, limit, deps)
    requests += p.requests
    if (!p.ok) return { ok: false, error: `${p.error} (page ${page}, offset ${offset})`, status: p.status, requests }
    pagesFetched++
    totalCount = p.totalCount
    dists.push(...p.dists)
    malformed += p.malformed
    offset += p.rawCount
    if (offset >= totalCount) break
    if (p.rawCount === 0) {
      return { ok: false, error: `SearchDistributions: empty page at offset ${offset} before totalCount ${totalCount}`, status: 200, requests }
    }
  }
  // The loop only exits through a page that read ok, so totalCount is that page's
  // count and pagesFetched is the pages actually read -- both measured, never defaulted.
  return { ok: true, dists, malformed, totalCount: totalCount as number, pages: pagesFetched, requests }
}

/**
 * The full edition pool of one distribution (Studio's `editionIds`), walking
 * GetDistributionEditions until its totalCount. All or nothing; the result is
 * de-duplicated, and a row without an editionId fails the walk (a pool missing
 * one edition would silently re-weight the EV).
 */
export async function fetchDistributionEditionIds(
  product: AtlasProduct,
  distributionId: string,
  deps: AtlasDeps,
  opts: { pageLimit?: number; maxPages?: number } = {},
): Promise<({ ok: true; editionIds: string[]; totalCount: number; requests: number }) | WalkFail> {
  const limit = opts.pageLimit ?? 100
  const maxPages = opts.maxPages ?? 30
  const ids: string[] = []
  let requests = 0
  let offset = 0
  let totalCount = 0
  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      return { ok: false, error: `GetDistributionEditions ${distributionId}: page cap ${maxPages} reached`, status: null, requests }
    }
    if (page > 0) await deps.sleep(deps.gapMs)
    const r = await atlasCall("DistributionService", "GetDistributionEditions", product, { distributionId, limit, offset }, deps)
    requests += r.attempts
    if (!r.ok) return { ok: false, error: `${r.error} (dist ${distributionId}, offset ${offset})`, status: r.status, requests }
    const p = parseDistributionEditionsPage(r.data)
    if (typeof p === "string") return { ok: false, error: `${p} (dist ${distributionId})`, status: 200, requests }
    if (p.malformed > 0) {
      return { ok: false, error: `GetDistributionEditions ${distributionId}: ${p.malformed} row(s) without an editionId`, status: 200, requests }
    }
    totalCount = p.totalCount
    ids.push(...p.editionIds)
    offset += p.rawCount
    if (offset >= totalCount) break
    if (p.rawCount === 0) {
      return { ok: false, error: `GetDistributionEditions ${distributionId}: empty page at offset ${offset} before totalCount ${totalCount}`, status: 200, requests }
    }
  }
  return { ok: true, editionIds: [...new Set(ids)], totalCount, requests }
}

/**
 * Offset cursor for the paged writers (AllDay, Golazos). pipeline_runs.cursor_after
 * held an opaque Studio cursor until the Atlas port; that is not an offset, so it
 * restarts the walk at 0 and says so. Never throws.
 */
export function parseOffsetCursor(cursor: string | null): { offset: number; reset: string | null } {
  if (cursor == null || cursor === "") return { offset: 0, reset: null }
  if (/^\d{1,9}$/.test(cursor)) return { offset: Number(cursor), reset: null }
  return { offset: 0, reset: `non-offset cursor ${JSON.stringify(cursor.slice(0, 40))} restarted at 0` }
}

/** Both supply counts present → read; either missing → unknown (never a 0 that reads as sold out). */
export function supplyOf(d: AtlasDist): { read: true; total: number; available: number } | { read: false } {
  return d.totalSupply != null && d.availableSupply != null
    ? { read: true, total: d.totalSupply, available: d.availableSupply }
    : { read: false }
}
