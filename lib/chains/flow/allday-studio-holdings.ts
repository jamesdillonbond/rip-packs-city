// lib/chains/flow/allday-studio-holdings.ts
//
// AllDay wallet holdings from Dapper's custody index — the ONLY source that can
// see LOCKED moments. Read from Studio GraphQL until 2026-11-17, from Atlas since
// 2026-11-18 (see the #218 note below the history).
//
// WHY THIS EXISTS
// ---------------
// The on-chain enumeration (GET_UNLOCKED_MOMENT_DETAILS in allday-cadence.ts)
// borrows /public/AllDayNFTCollection and returns getIDs(). NFL All Day has NO
// on-chain locking contract — only `AllDay` + `PackNFT` are deployed at
// 0xe4cf4bdc1751c65d (verified live 2026-08-08), so a "locked" moment is not an
// NFT flagged in place (the way TopShotLocking works); it is simply NOT in the
// holder's own account. Dapper custodies it. getIDs() therefore CANNOT see it,
// and the wallet reads as owning fewer moments than it does — 0, if every
// AllDay moment it holds is locked. That is the visible bug this module fixes:
// wallet 0xdcd41c74d2dd0a66 (ThunderHour) scanned ok=true / rows_found=0 while
// holding 5 moments, 3 of them shown with padlocks on its public profile.
//
// WHY NOT THE ALLDAY GRAPHQL THE OLD COMMENTS POINT AT
// ---------------------------------------------------
// Both AllDay marketplace GQL surfaces are DEAD and were re-verified dead from a
// residential IP on 2026-08-08 (not merely blocked at the worker egress):
//   public-api.nflallday.com/graphql  -> nginx 404 (path no longer resolves)
//   nflallday.com/consumer/graphql    -> 403 block page
// studio-platform is the live Dapper index and is reachable UNAUTHENTICATED from
// Vercel egress with an Origin header — the same endpoint the green
// allday-studio-sales-history-backfill / pinnacle-catalog routes already use.
//
// ⚠ THE FOOTGUN: owner_address is stored BARE HEX, no 0x prefix.
// Querying with "0xdcd41c74d2dd0a66" returns totalCount 0 — a silent empty, not
// an error. It MUST be stripped. stripFlowPrefix() below is the only place that
// happens; every caller goes through it.
//
// ⚠ THIS SOURCE AUGMENTS, IT DOES NOT REPLACE, THE ON-CHAIN WALK.
// studio's owner_address can be STALE: it tracks the last owner Dapper's index
// observed, so a moment moved on-chain outside the Dapper marketplace keeps its
// old owner. Verified case (2026-08-08): AllDay moment 1557801 is held on-chain
// by 0x11859edcf2f53edd, while studio still attributes it to a 2022 owner. So
// the runner UNIONs the two sources and lets the chain win on conflict — the
// chain is ground truth for what it can see, studio adds only what the chain
// structurally cannot see. Never treat studio as authoritative on its own, and
// never use it to DELETE a wmc row.
//
// Field agreement was verified before wiring: across the 32 moments held by
// 0x11859edcf2f53edd that appear in BOTH sources, studio `edition.id` and
// `serial_number` matched the on-chain `editionID` / `serialNumber` exactly
// (32 agree / 0 disagree), so unioned rows carry a consistent edition_key.

// ── 2026-11-18 (#218): THE SOURCE IS NOW ATLAS, NOT STUDIO ─────────────────
// Studio GraphQL (searchAllDayNft) has answered HTTP 530 since 11-17, which made
// this walk ok:false on EVERY wallet: locked moments went missing from new scans
// and the caller skipped delete-not-seen for every All Day wallet. Dapper's Atlas
// API (NFTService/SearchNftsByOwner, product 'nfl') is the same custody index:
// it answers nfts[{id, editionId, serialNumber, isLocked}] + pagination{totalCount,
// hasMore} for a BARE-hex owner, with `limit` clamped to 100 (measured 11-18;
// 0xbd94cade097e50ac totalCount 3807, 0xdcd41c74d2dd0a66 its 3 locked moments).
// Vercel's egress is firewalled by Atlas, so a page is one pg_net round trip:
// atlas_allday_nfts_by_owner_begin + the shared atlas_await_response. Everything
// said above about STALENESS still holds: augment the chain, never replace it,
// never delete from it. The export names keep "Studio" so the caller's telemetry
// (studio_ok, studio_count, …) stays comparable across the switch.

// Atlas clamps limit to 100. 200 pages = 20,000 moments; the elapsed budget is
// the real limiter. Pages go out in waves of PAGE_CONCURRENCY after page 0 has
// told us the total, so a 3,807-moment wallet is 1 + 5 waves, not 39 round trips.
const PAGE_SIZE = 100
const MAX_PAGES = 200
const PAGE_CONCURRENCY = 8
const ELAPSED_BUDGET_MS = 60_000

/** [nftId, editionId, serialNumber] — same tuple shape the Cadence details script returns. */
export type HoldingTriple = [string, string, string]

export interface StudioHoldingsResult {
  /** false when the walk failed or was cut short; callers must NOT treat a failed walk as "no locked moments". */
  ok: boolean
  triples: HoldingTriple[]
  /** the index's reported total for the owner (page-1 value), null when unknown. */
  totalCount: number | null
  pagesFetched: number
  /** true when MAX_PAGES / the elapsed budget stopped the walk before the end. */
  truncated: boolean
  error?: string
}

/** The custody index stores owner addresses as bare hex. Stripping is mandatory — see the header note. */
export function stripFlowPrefix(address: string): string {
  return address.trim().replace(/^0x/i, "").toLowerCase()
}

export interface AtlasNftNode {
  id?: string | number | null
  editionId?: string | number | null
  serialNumber?: string | number | null
}

export interface AtlasOwnerPage {
  nfts: AtlasNftNode[]
  totalCount: number | null
  hasMore: boolean
}

/** Fetch one page (offset is a multiple of PAGE_SIZE). THROWS on any failure. */
export type AtlasOwnerPageFetcher = (owner: string, offset: number) => Promise<AtlasOwnerPage>

/** Parse an Atlas SearchNftsByOwner body. A body without an `nfts` array is a failure, not "holds nothing". */
export function parseAtlasOwnerPage(body: unknown): AtlasOwnerPage {
  const b = body as { nfts?: unknown; pagination?: { totalCount?: unknown; hasMore?: unknown } } | null
  if (!b || !Array.isArray(b.nfts)) throw new Error("atlas response carried no nfts array")
  const rawTotal = b.pagination?.totalCount
  const total = rawTotal == null ? null : Number(rawTotal)
  return {
    nfts: b.nfts as AtlasNftNode[],
    totalCount: total !== null && Number.isFinite(total) ? total : null,
    hasMore: b.pagination?.hasMore === true,
  }
}

/** The production fetcher: one pg_net round trip; a Cloudflare challenge (403/429) is retried once. */
export const atlasOwnerPageViaPgNet: AtlasOwnerPageFetcher = async (owner, offset) => {
  // Lazy import keeps this module importable by unit tests with no Supabase env.
  const { supabaseAdmin } = await import("@/lib/supabase")
  const { boundedRead } = await import("@/lib/api/bounded-read")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let last = "no response"
  for (let attempt = 1; attempt <= 2; attempt++) {
    const begin = await boundedRead(
      db.rpc("atlas_allday_nfts_by_owner_begin", { p_wallet: `0x${owner}`, p_offset: offset }),
      "allday-holdings/atlas-begin",
      5_000,
    )
    if (begin.error) throw new Error(`atlas begin: ${begin.error.message ?? "failed"}`)
    const id = Number(begin.data)
    if (!Number.isFinite(id) || id <= 0) throw new Error("atlas begin returned no request id")
    const col = await boundedRead(
      db.rpc("atlas_await_response", { p_request_id: id, p_max_ms: 10_000 }),
      "allday-holdings/atlas-await",
      14_000,
    )
    if (col.error) throw new Error(`atlas await: ${col.error.message ?? "failed"}`)
    const env = col.data as { ok?: boolean; body?: unknown; status?: number | null } | null
    if (env?.ok === true) return parseAtlasOwnerPage(env.body)
    last = env?.status != null ? `atlas http_${env.status}` : "atlas no response"
    if (!(env?.status === 403 || env?.status === 429)) break
  }
  throw new Error(last)
}

/**
 * Walk every AllDay moment the custody index attributes to `wallet`, including
 * Dapper-custodied (locked) moments the on-chain collection cannot expose.
 *
 * FAIL-SOFT BY CONTRACT: never throws. An index outage must not turn a working
 * on-chain backfill into a failed one, so the caller gets ok:false and proceeds
 * with the chain result alone (and skips delete-not-seen).
 */
export async function fetchAllDayStudioHoldings(
  wallet: string,
  opts: { fetchPage?: AtlasOwnerPageFetcher; now?: () => number } = {},
): Promise<StudioHoldingsResult> {
  const fetchPage = opts.fetchPage ?? atlasOwnerPageViaPgNet
  const now = opts.now ?? Date.now
  const startedMs = now()
  const owner = stripFlowPrefix(wallet)

  const triples: HoldingTriple[] = []
  const seen = new Set<string>()
  // Every distinct id the index RETURNED, usable or not — the completeness check below.
  const returned = new Set<string>()
  let totalCount: number | null = null
  let pagesFetched = 0
  let truncated = false

  if (!/^[0-9a-f]{16}$/.test(owner)) {
    return { ok: false, triples: [], totalCount: null, pagesFetched: 0, truncated: false, error: owner ? "bad_wallet" : "empty_wallet" }
  }

  const take = (page: AtlasOwnerPage) => {
    pagesFetched++
    for (const node of page.nfts) {
      const nftId = node?.id == null ? null : String(node.id)
      if (nftId) returned.add(nftId)
      const editionId = node?.editionId == null ? null : String(node.editionId)
      // "0" is Atlas's empty value, never a real id.
      if (!nftId || nftId === "0" || !editionId || editionId === "0") continue
      if (seen.has(nftId)) continue
      seen.add(nftId)
      const serialRaw = node?.serialNumber
      triples.push([nftId, editionId, serialRaw == null ? "" : String(serialRaw)])
    }
  }

  try {
    const first = await fetchPage(owner, 0)
    totalCount = first.totalCount
    take(first)

    if (first.hasMore || (totalCount !== null && totalCount > PAGE_SIZE)) {
      // Without a total there is no way to plan the waves, and walking blind on
      // hasMore alone is how a short page used to end a walk early: refuse it.
      if (totalCount === null) throw new Error("atlas reported more pages but no totalCount")
      const pagesNeeded = Math.ceil(totalCount / PAGE_SIZE)
      const lastPage = Math.min(pagesNeeded, MAX_PAGES)
      if (pagesNeeded > MAX_PAGES) truncated = true
      for (let p = 1; p < lastPage; p += PAGE_CONCURRENCY) {
        if (now() - startedMs > ELAPSED_BUDGET_MS) {
          truncated = true
          break
        }
        const wave: number[] = []
        for (let q = p; q < Math.min(p + PAGE_CONCURRENCY, lastPage); q++) wave.push(q * PAGE_SIZE)
        const pages = await Promise.all(wave.map((offset) => fetchPage(owner, offset)))
        for (const pg of pages) take(pg)
      }
    }

    // A walk that RETURNED fewer distinct moments than the index says the wallet
    // holds is not the holdings — offset paging that shifted under a concurrent
    // transfer, or pages answering the same rows. ok:false keeps the caller from
    // deleting on it (the direction that loses data).
    if (!truncated && totalCount !== null && returned.size < totalCount) {
      return {
        ok: false,
        triples,
        totalCount,
        pagesFetched,
        truncated,
        error: `short walk: ${returned.size} of ${totalCount} returned`,
      }
    }
    return { ok: !truncated, triples, totalCount, pagesFetched, truncated }
  } catch (err) {
    return {
      ok: false,
      triples,
      totalCount,
      pagesFetched,
      truncated,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Union the on-chain triples with the studio (custody) triples, keyed on nftId.
 * THE CHAIN WINS on conflict — it is ground truth for everything it can see;
 * studio only contributes moments the chain structurally cannot expose.
 *
 * On-chain entries are passed through VERBATIM, including malformed ones. That
 * is deliberate: `merged.length` feeds pipeline_runs.rows_found, which has
 * always meant "raw on-chain scan count", and the caller's row-builder already
 * skips tuples with < 2 elements. Filtering here would silently redefine a
 * long-standing telemetry field (pinned by wallet-backfill-helpers.test.ts).
 */
export function unionHoldingTriples(
  onChain: readonly (readonly unknown[])[],
  studio: readonly HoldingTriple[],
): { merged: unknown[][]; addedFromStudio: number } {
  const merged: unknown[][] = []
  const seen = new Set<string>()

  for (const tri of onChain) {
    merged.push(tri as unknown[])
    if (Array.isArray(tri) && tri.length >= 1 && tri[0] != null) seen.add(String(tri[0]))
  }

  let addedFromStudio = 0
  for (const tri of studio) {
    const nftId = String(tri[0])
    if (seen.has(nftId)) continue
    seen.add(nftId)
    merged.push([nftId, String(tri[1]), String(tri[2] ?? "")])
    addedFromStudio++
  }

  return { merged, addedFromStudio }
}
