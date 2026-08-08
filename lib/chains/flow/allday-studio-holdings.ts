// lib/chains/flow/allday-studio-holdings.ts
//
// AllDay wallet holdings from the Dapper studio-platform GraphQL — the ONLY
// source that can see LOCKED moments.
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

const STUDIO_GQL = "https://api.production.studio-platform.dapperlabs.com/graphql"
const ORIGIN = "https://nflallday.com"

// Page size 500 is validated against a 3,707-moment wallet (0xbd94cade097e50ac)
// — 8 pages, no error. MAX_PAGES bounds a pathological wallet; the elapsed
// budget is the real limiter.
const PAGE_SIZE = 500
const MAX_PAGES = 120
const PER_REQUEST_TIMEOUT_MS = 20_000
const INTER_PAGE_DELAY_MS = 150
const ELAPSED_BUDGET_MS = 60_000

/** [nftId, editionId, serialNumber] — same tuple shape the Cadence details script returns. */
export type HoldingTriple = [string, string, string]

export interface StudioHoldingsResult {
  /** false when the walk failed or was cut short; callers must NOT treat a failed walk as "no locked moments". */
  ok: boolean
  triples: HoldingTriple[]
  /** studio's reported total for the owner (page-1 value), null when unknown. */
  totalCount: number | null
  pagesFetched: number
  /** true when MAX_PAGES / the elapsed budget stopped the walk before the end. */
  truncated: boolean
  error?: string
}

/** studio stores owner_address as bare hex. Stripping is mandatory — see the header note. */
export function stripFlowPrefix(address: string): string {
  return address.trim().replace(/^0x/i, "").toLowerCase()
}

const HOLDINGS_QUERY = `
query AllDayHoldings($input: SearchAllDayNftsInput!) {
  searchAllDayNft(searchInput: $input) {
    totalCount
    edges {
      cursor
      node {
        id
        serial_number
        edition { id }
      }
    }
  }
}`

interface StudioEdge {
  cursor?: string | null
  node?: {
    id?: string | number | null
    serial_number?: string | number | null
    edition?: { id?: string | number | null } | null
  } | null
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

async function postStudio(
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<{ edges: StudioEdge[]; totalCount: number | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetchImpl(STUDIO_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
      },
      body: JSON.stringify({ query: HOLDINGS_QUERY, variables }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`studio http_${res.status}: ${text.slice(0, 160)}`)
    }
    const json = JSON.parse(text)
    if (json?.errors?.length) {
      throw new Error(
        `studio gql_errors: ${json.errors.map((e: any) => e?.message).filter(Boolean).join("; ").slice(0, 200)}`,
      )
    }
    const payload = json?.data?.searchAllDayNft
    if (!payload) throw new Error("studio returned no searchAllDayNft payload")
    const rawTotal = payload.totalCount
    const total = rawTotal == null ? null : Number(rawTotal)
    return {
      edges: Array.isArray(payload.edges) ? payload.edges : [],
      totalCount: Number.isFinite(total as number) ? (total as number) : null,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Walk every AllDay moment studio-platform attributes to `wallet`, including
 * Dapper-custodied (locked) moments the on-chain collection cannot expose.
 *
 * FAIL-SOFT BY CONTRACT: never throws. A studio outage must not turn a working
 * on-chain backfill into a failed one, so the caller gets ok:false + an empty
 * triple list and proceeds with the chain result alone.
 */
export async function fetchAllDayStudioHoldings(
  wallet: string,
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<StudioHoldingsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const startedMs = now()
  const owner = stripFlowPrefix(wallet)

  const triples: HoldingTriple[] = []
  const seen = new Set<string>()
  let after: string | null = null
  let totalCount: number | null = null
  let pagesFetched = 0
  let truncated = false

  if (!owner) {
    return { ok: false, triples: [], totalCount: null, pagesFetched: 0, truncated: false, error: "empty_wallet" }
  }

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (now() - startedMs > ELAPSED_BUDGET_MS) {
        truncated = true
        break
      }
      const input: Record<string, unknown> = {
        first: PAGE_SIZE,
        filters: [{ owner_address: { eq: owner } }],
      }
      if (after) input.after = after

      const { edges, totalCount: pageTotal } = await postStudio({ input }, fetchImpl)
      pagesFetched++
      // studio's totalCount is the true total on page 1 and then decrements as a
      // per-page remaining count, so page 1 is the one to keep.
      if (totalCount === null && pageTotal !== null) totalCount = pageTotal
      if (edges.length === 0) break

      for (const edge of edges) {
        const node = edge?.node
        const nftId = node?.id == null ? null : String(node.id)
        const editionId = node?.edition?.id == null ? null : String(node.edition.id)
        if (!nftId || !editionId) continue
        if (seen.has(nftId)) continue
        seen.add(nftId)
        const serialRaw = node?.serial_number
        const serial = serialRaw == null ? "" : String(serialRaw)
        triples.push([nftId, editionId, serial])
      }

      const nextCursor = edges[edges.length - 1]?.cursor
      if (!nextCursor) break
      after = nextCursor
      if (totalCount !== null && triples.length >= totalCount) break
      if (page === MAX_PAGES - 1) truncated = true
      await delay(INTER_PAGE_DELAY_MS)
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
