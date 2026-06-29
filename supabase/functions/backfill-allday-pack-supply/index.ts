// backfill-allday-pack-supply  (v2 — now also captures packOdds + editionIds)
// Fills the durable allday_pack_supply table from the Dapper Studio Platform
// searchDistributions API (byProductID "AllDay"; reachable from Supabase egress,
// no proxy/secret). dist_id = String(node.id) to match pack_distributions/pack_ev_latest.
//
// v2 additions (the AllDay-EV fix foundation):
//   - SEARCH_QUERY now selects editionIds + packOdds { tier value displayValue }.
//   - Stores pack_odds (jsonb) + edition_ids (jsonb) + title so a corrected,
//     odds-weighted EV view can replace the uniform-weight (drop_weight=1) model
//     that inflates AllDay EV.
//   - Dedups rows per page by dist_id before upsert (fixes the prior
//     "ON CONFLICT DO UPDATE cannot affect row a second time" early-break bug).
//   - Never break on a single page error — log lastErr + continue paginating so
//     coverage is complete (the prior bug stopped at the first dup-collision page).
//   - opened/sealed/depletion are LEFT NULL on purpose: availableSupply is
//     degenerate (==totalSupply) for AllDay, so those numbers are not trustworthy.
// Gated by ?key=; verify_jwt=false. Run synchronously (~14 pages of 100).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const GATE = "rpc_pls_8x2f9k3m_allday"
const GQL_ENDPOINT = "https://api.production.studio-platform.dapperlabs.com/graphql"
const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")
const H = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  "Origin": "https://nflallday.com",
  "Referer": "https://nflallday.com/",
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const SEARCH_QUERY = `
  query FetchAllDayDistributions($input: SearchDistributionsInput!) {
    searchDistributions(input: $input) {
      pageInfo { endCursor hasNextPage }
      edges { node {
        uuid id title
        numberOfPackSlots
        totalSupply availableSupply
        price { value }
        editionIds
        packOdds { tier value displayValue }
      } }
    }
  }
`

async function gqlCall(variables: Record<string, unknown>) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res: Response
    try { res = await fetch(GQL_ENDPOINT, { method: "POST", headers: H, body: JSON.stringify({ query: SEARCH_QUERY, variables }), signal: AbortSignal.timeout(25000) }) }
    catch (err) { if (attempt < 4) { await sleep(1000 * attempt); continue } return { ok: false as const, error: `fetch: ${err instanceof Error ? err.message : String(err)}` } }
    if (!res.ok) { if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1200 * attempt); continue } return { ok: false as const, error: `HTTP ${res.status}` } }
    const json = await res.json().catch(() => null) as any
    if (!json) return { ok: false as const, error: "not-json" }
    if (json.errors?.length) return { ok: false as const, error: json.errors[0].message }
    return { ok: true as const, data: json.data }
  }
  return { ok: false as const, error: "retries_exhausted" }
}

async function run() {
  let cursor: string | null = null
  let pages = 0, upserted = 0, scanned = 0, withOdds = 0, pageErrs = 0
  let lastErr: string | null = null
  for (; pages < 80; pages++) {
    const r = await gqlCall({ input: { first: 100, after: cursor, filters: { byProductID: "AllDay" } } })
    if (!r.ok) { lastErr = String(r.error); pageErrs++; break }   // a GQL failure means no cursor to advance → stop
    const conn = r.data?.searchDistributions
    const nodes = (conn?.edges ?? []).map((e: any) => e?.node).filter((n: any) => n != null)
    scanned += nodes.length

    // Build rows, then DEDUP by dist_id (keep last) so a single upsert batch never
    // touches the same conflict target twice.
    const byDist = new Map<string, Record<string, unknown>>()
    for (const n of nodes) {
      const minted = Number(n.totalSupply ?? 0)
      const available = Number(n.availableSupply ?? 0)
      const odds = Array.isArray(n.packOdds) ? n.packOdds : null
      if (odds && odds.length) withOdds++
      byDist.set(String(n.id), {
        dist_id: String(n.id),
        total_minted: minted,           // reliable drop size
        available,                      // == minted for AllDay (degenerate) — informational only
        pack_price: n.price?.value != null ? Number(n.price.value) : null,
        slots: n.numberOfPackSlots ?? null,
        pack_odds: odds,                // [{tier,value,displayValue}] — the missing weights
        edition_ids: Array.isArray(n.editionIds) ? n.editionIds : null,
        title: n.title ?? null,
        supply_ok: true,
        updated_at: new Date().toISOString(),
        // opened/sealed/depletion deliberately omitted (degenerate for AllDay)
      })
    }
    const rows = Array.from(byDist.values())
    if (rows.length) {
      const { error } = await supabase.from("allday_pack_supply").upsert(rows, { onConflict: "dist_id" })
      if (error) { lastErr = "upsert: " + error.message; pageErrs++ }   // log + CONTINUE (don't break)
      else upserted += rows.length
    }
    if (!conn?.pageInfo?.hasNextPage) break
    cursor = conn.pageInfo.endCursor
    await sleep(250)
  }
  return { pages, scanned, upserted, withOdds, pageErrs, lastErr }
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  if (url.searchParams.get("key") !== GATE) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } })
  const result = await run()
  return new Response(JSON.stringify({ done: true, ...result }), { status: 200, headers: { "content-type": "application/json" } })
})
