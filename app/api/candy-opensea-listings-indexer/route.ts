// app/api/candy-opensea-listings-indexer/route.ts
//
// Candy (Solana) secondary LISTINGS from OPENSEA — the second ask feed beside
// /api/candy-listings-indexer (Magic Eden). OpenSea added Solana NFT trading
// ~2026-08-31 with Candy Digital as a named launch partner; until this route, a
// Candy ask standing on OpenSea was captured NOWHERE, so the deals / market /
// floor family could read "no ask" where a real one stood.
// See docs/overnight/inbox/2026-09-02T0400Z-candy-secondary-is-no-longer-magic-eden-only-*.md
//
// ── THE SHAPE, FROM OPENSEA'S OWN OPENAPI SPEC (@opensea/api-types 0.16.0) ──────
// Their API and docs host are unreachable from the build sandbox, so every field
// below is read from the published spec, not inferred from the Panini (Ethereum)
// route:
//   · A Solana order has NO `order_hash`. It carries `svm_order`
//     { id = "creation_signature:order_state", order_state, creation_signature,
//       asset_id?, maker }. `order_state` is the on-chain account holding the
//     order — the Solana analogue of Magic Eden's `pdaAddress`, so it is what this
//     route writes into `pda_address`.
//   · `price.current` { currency, decimals, value } is what a BUYER pays through
//     OpenSea — for a listing ingested from another marketplace it may INCLUDE
//     OpenSea's fee. Stated so nobody reads an OpenSea ask as the seller's net.
//   · OpenSea's feed AGGREGATES other Solana marketplaces ("listings and offers
//     created on other Solana marketplaces can be read"). So this feed WILL
//     return asks Magic Eden's sweep already holds — see DEDUP below.
//   · Every v2 endpoint requires `x-api-key` (spec `security: ApiKeyAuth`).
//
// ── DEDUP: ONE LIVE ASK PER 1-OF-1 ───────────────────────────────────────────────
// A Candy card is a 1-of-1 Metaplex Core asset, and a Magic Eden listing MOVES it
// into ME's escrow (lib/chains/solana/escrow.ts), so it cannot simultaneously be
// listed by its owner anywhere else. Hence: for a mint that already has an ACTIVE
// venue='magic_eden' row, an OpenSea-reported ask is the SAME listing seen
// through the aggregator (or a stale echo of it) — it is SKIPPED and counted
// (`skipped_me_active`), never written twice. Only asks for mints with no active
// ME row are written, as venue='opensea'. `matched_me_pda` counts how many
// reported order_state values equal an ME pda_address outright — the first ticks
// measure whether the two identities coincide.
//
// ── RETIREMENT IS EVIDENCE-BASED, NEVER ABSENCE-BASED ───────────────────────────
// The rule this estate learned the hard way (a short Magic Eden answer once wiped
// 419 live asks): a row this sweep did not see is NOT dead. For each active
// venue='opensea' row the sweep did not re-see, the route asks OpenSea's
// get-order endpoint for THAT order and retires it only on a terminal status
// (FULFILLED / CANCELLED / EXPIRED / INACTIVE). A failed or ambiguous lookup
// retires nothing. The Magic Eden indexer's supersede pass and the shared
// `candy_retire_listings_sold_since_seen` RPC also retire these rows on their
// own positive evidence (a newer live listing for the mint; a recorded sale).
//
// ── HONESTY ─────────────────────────────────────────────────────────────────────
// A listing is an ASK, never FMV (same constraint as the Magic Eden route).
// A missing OPENSEA_API_KEY is OUR misconfiguration: it is logged ok=false with
// that exact cause, never as a clean "0 listings" run.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { solUsd } from "@/lib/chains/solana/das"
import { CANDY_MLB_SLUG, CANDY_MLB_UUID } from "@/lib/chains/solana/normalize"
import { MAGIC_EDEN_SOLANA_ESCROW } from "@/lib/chains/solana/escrow"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-opensea-listings-indexer"
const OS_BASE = "https://api.opensea.io/api/v2"
// Spec: `limit` maximum 200 on /listings/collection/{slug}/all.
const OS_LIMIT = 200
// 50 x 200 = 10,000 asks — far above the whole Candy book (~1,500 active on ME),
// so a cursor that ends is what ends the sweep, not this cap.
const MAX_PAGES = 50
// Per-request cap: `fetch()` has no default timeout, and an upstream holding a
// connection open consumes the whole lambda (the 2026-08-27 44 h Candy blackout).
const OS_FETCH_TIMEOUT_MS = 15_000
// Whole-sweep budget, under the 300 s wall so `logRun` always gets to run.
const SWEEP_BUDGET_MS = 240_000
// Bound on per-order status lookups per tick (the retirement pass). The rest
// wait for the next tick — no evidence means no retirement, never the reverse.
const MAX_STATUS_CHECKS = 150
// Pages of a holder's NFTs read while discovering the collection slug.
const DISCOVERY_PAGES = 3

const TERMINAL_STATUSES = new Set(["FULFILLED", "CANCELLED", "EXPIRED", "INACTIVE"])

interface OsPrice {
  currency?: string
  decimals?: number
  value?: string
}

interface OsListing {
  chain?: string
  protocol_address?: string
  protocol?: string
  status?: string
  remaining_quantity?: number
  asset?: { identifier?: string | null; contract?: string } | null
  svm_order?: {
    id?: string
    order_state?: string
    creation_signature?: string
    asset_id?: string
    maker?: string
  }
  price?: { current?: OsPrice }
}

function osHeaders(apiKey: string): Record<string, string> {
  return { Accept: "application/json", "x-api-key": apiKey }
}

async function osGet(path: string, apiKey: string): Promise<{ status: number; json: any }> {
  const resp = await fetch(`${OS_BASE}${path}`, {
    headers: osHeaders(apiKey),
    signal: AbortSignal.timeout(OS_FETCH_TIMEOUT_MS),
  })
  if (!resp.ok) {
    const body = (await resp.text().catch(() => "")).slice(0, 200)
    const err = new Error(`OpenSea ${path.split("?")[0]} HTTP ${resp.status}: ${body}`) as Error & { status?: number }
    err.status = resp.status
    throw err
  }
  return { status: resp.status, json: await resp.json() }
}

/**
 * Convert OpenSea's `price.current` to { sol, usd }. SOL is priced in lamports
 * (decimals 9); a stablecoin ask is USD at face value. Any other currency, or a
 * non-positive amount, returns null — the ask is skipped and counted, never
 * converted by a guessed rate.
 */
export function osPrice(p: OsPrice | undefined, solRate: number | null): { sol: number | null; usd: number | null } | null {
  if (!p || p.value == null || p.decimals == null) return null
  const raw = Number(p.value)
  if (!Number.isFinite(raw) || raw <= 0) return null
  const amount = raw / Math.pow(10, p.decimals)
  const cur = String(p.currency ?? "").toUpperCase()
  if (cur === "SOL" || cur === "WSOL") {
    return { sol: amount, usd: solRate != null ? Number((amount * solRate).toFixed(2)) : null }
  }
  if (cur === "USDC" || cur === "USDT") {
    return { sol: solRate ? Number((amount / solRate).toFixed(9)) : null, usd: Number(amount.toFixed(2)) }
  }
  return null
}

/** The asset mint an OpenSea Solana listing is for. */
export function listingMint(l: OsListing): string | null {
  return l.asset?.identifier || l.svm_order?.asset_id || null
}

async function logRun(
  startedAtIso: string,
  rowsFound: number,
  rowsWritten: number,
  rowsSkipped: number,
  ok: boolean,
  error: string | null,
  extra: Record<string, unknown>,
) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: rowsFound,
      p_rows_written: rowsWritten,
      p_rows_skipped: rowsSkipped,
      p_ok: ok,
      p_error: error,
      p_collection_slug: CANDY_MLB_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: extra,
    })
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Find Candy MLB's OpenSea collection slug from the chain, not from a guess:
 * take a real Candy holder from wallet_moments_cache, list that wallet's NFTs on
 * OpenSea, and read `collection` off an NFT whose identifier IS one of the
 * holder's Candy mints. If OpenSea's identifier is not the mint, nothing matches
 * and discovery fails LOUDLY (the run logs ok=false) rather than adopting a slug
 * from some other collection the wallet holds.
 * `CANDY_MLB_OPENSEA_SLUG` overrides discovery.
 */
async function discoverSlug(apiKey: string): Promise<{ slug: string | null; how: string; sampleUrl: string | null }> {
  const pinned = process.env.CANDY_MLB_OPENSEA_SLUG?.trim()
  if (pinned) return { slug: pinned, how: "env", sampleUrl: null }

  const { data: seed, error: seedErr } = await (supabaseAdmin as any)
    .from("wallet_moments_cache")
    .select("wallet_address")
    .eq("collection_id", CANDY_MLB_UUID)
    .neq("wallet_address", MAGIC_EDEN_SOLANA_ESCROW)
    // No ORDER BY on purpose: any real holder serves, and sorting the Candy slice
    // of wmc by last_seen_at measured 21k buffers / 4.5 s per tick (2026-10-10).
    .limit(1)
  if (seedErr) throw new Error(`slug discovery: holder read failed: ${seedErr.message}`)
  const wallet: string | undefined = seed?.[0]?.wallet_address
  if (!wallet) return { slug: null, how: "no_holder", sampleUrl: null }

  const { data: mintRows, error: mintErr } = await (supabaseAdmin as any)
    .from("wallet_moments_cache")
    .select("moment_id")
    .eq("collection_id", CANDY_MLB_UUID)
    .eq("wallet_address", wallet)
    .limit(1000)
  if (mintErr) throw new Error(`slug discovery: holder mints read failed: ${mintErr.message}`)
  const mints = new Set(((mintRows ?? []) as Array<{ moment_id: string }>).map((r) => r.moment_id))

  let next: string | null = null
  for (let p = 0; p < DISCOVERY_PAGES; p++) {
    const qs = `limit=200${next ? `&next=${encodeURIComponent(next)}` : ""}`
    const { json } = await osGet(`/chain/solana/account/${encodeURIComponent(wallet)}/nfts?${qs}`, apiKey)
    for (const n of (json?.nfts ?? []) as Array<{ identifier?: string; collection?: string; opensea_url?: string }>) {
      if (n.identifier && n.collection && mints.has(n.identifier)) {
        // `opensea_url` is logged so the Solana item-page format is MEASURED, not
        // guessed, before any surface links to it.
        return { slug: n.collection, how: "holder_match", sampleUrl: n.opensea_url ?? null }
      }
    }
    next = json?.next ?? null
    if (!next) break
  }
  return { slug: null, how: "no_match", sampleUrl: null }
}

function authed(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? ""
  const ingest = process.env.INGEST_SECRET_TOKEN
  const cron = process.env.CRON_SECRET
  if (ingest && header === `Bearer ${ingest}`) return true
  if (cron && header === `Bearer ${cron}`) return true
  return false
}

export async function GET(req: NextRequest) {
  return handleSweep(req)
}

export async function POST(req: NextRequest) {
  return handleSweep(req)
}

async function handleSweep(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  // Separate `-heartbeat` pipeline name: a kill inside after() then reads as
  // "heartbeat, no terminal row" instead of "the cron never fired".
  await writeInvocationHeartbeat({
    pipeline: PIPELINE_NAME,
    startedAtMs: startedMs,
    collectionSlug: CANDY_MLB_SLUG,
  })

  const apiKey = process.env.OPENSEA_API_KEY ?? ""
  if (!apiKey) {
    // Ours, not OpenSea's: every v2 call 401s without a key. ok=false with the
    // cause named, so the run row cannot read as an empty OpenSea book.
    console.error(`[${PIPELINE_NAME}] OPENSEA_API_KEY is not set — no OpenSea Candy asks can be read`)
    await logRun(startedAtIso, 0, 0, 0, false, "OPENSEA_API_KEY not set (misconfiguration, not an OpenSea outage)", {
      skip_reason: "opensea_key_missing",
    })
    return NextResponse.json(
      { accepted: false, skipped: "opensea_key_missing", collection: CANDY_MLB_SLUG },
      { status: 202 },
    )
  }

  after(async () => {
    let found = 0
    let written = 0
    let skipped = 0
    let retired = 0
    let sweepComplete = false
    let budgetExhausted = false
    let pages = 0
    let slug: string | null = null
    let slugHow: string | null = null
    let sampleUrl: string | null = null
    const writeErrors: string[] = []
    try {
      const d = await discoverSlug(apiKey)
      slug = d.slug
      slugHow = d.how
      sampleUrl = d.sampleUrl
      if (!slug) {
        await logRun(startedAtIso, 0, 0, 0, false, `OpenSea collection slug not found (${d.how})`, {
          skip_reason: "slug_not_found",
          slug_discovery: d.how,
          duration_ms: Date.now() - startedMs,
        })
        return
      }

      const rate = await solUsd()

      // ── 1. Walk the OpenSea book ──────────────────────────────────────────
      let rawSeen = 0
      let notActive = 0
      let noIdentity = 0
      let unpriced = 0
      const protocols: Record<string, number> = {}
      const reported: Array<{ l: OsListing; mint: string; state: string }> = []
      let next: string | null = null
      for (; pages < MAX_PAGES; pages++) {
        if (Date.now() - startedMs > SWEEP_BUDGET_MS) {
          budgetExhausted = true
          break
        }
        const qs = `limit=${OS_LIMIT}${next ? `&next=${encodeURIComponent(next)}` : ""}`
        const { json } = await osGet(`/listings/collection/${encodeURIComponent(slug)}/all?${qs}`, apiKey)
        const listings = (json?.listings ?? []) as OsListing[]
        rawSeen += listings.length
        for (const l of listings) {
          const key = l.protocol ?? "(none)"
          protocols[key] = (protocols[key] ?? 0) + 1
          if ((l.status && l.status !== "ACTIVE") || (l.remaining_quantity != null && l.remaining_quantity <= 0)) {
            notActive++
            continue
          }
          const mint = listingMint(l)
          const state = l.svm_order?.order_state
          if (!mint || !state) {
            noIdentity++
            continue
          }
          reported.push({ l, mint, state })
        }
        next = json?.next ?? null
        if (!next) {
          sweepComplete = true
          pages++
          break
        }
      }

      // ── 2. Resolve mints → Candy editions (cards) / packs, batched ────────
      const mints = [...new Set(reported.map((r) => r.mint))]
      const keyByMint = new Map<string, string>()
      for (let i = 0; i < mints.length; i += 200) {
        const { data, error } = await (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .select("moment_id, edition_key")
          .eq("collection_id", CANDY_MLB_UUID)
          .in("moment_id", mints.slice(i, i + 200))
        // THROW: a failed read must not classify a real Candy ask "not Candy".
        if (error) throw new Error(`wmc batch lookup failed: ${error.message}`)
        for (const r of (data ?? []) as Array<{ moment_id: string; edition_key: string | null }>) {
          if (r.edition_key && !keyByMint.has(r.moment_id)) keyByMint.set(r.moment_id, r.edition_key)
        }
      }
      const keys = [...new Set(keyByMint.values())]
      const idByKey = new Map<string, string>()
      for (let i = 0; i < keys.length; i += 200) {
        const { data, error } = await (supabaseAdmin as any)
          .from("editions")
          .select("id, external_id")
          .eq("collection_id", CANDY_MLB_UUID)
          .in("external_id", keys.slice(i, i + 200))
        if (error) throw new Error(`editions batch lookup failed: ${error.message}`)
        for (const r of (data ?? []) as Array<{ id: string; external_id: string }>) {
          if (!idByKey.has(r.external_id)) idByKey.set(r.external_id, r.id)
        }
      }

      // ── 3. Dedup against the Magic Eden book ──────────────────────────────
      const cardMints = mints.filter((m) => keyByMint.has(m))
      const meActive = new Set<string>()
      for (let i = 0; i < cardMints.length; i += 200) {
        const { data, error } = await (supabaseAdmin as any)
          .from("candy_listings")
          .select("token_mint")
          .eq("venue", "magic_eden")
          .eq("is_active", true)
          .in("token_mint", cardMints.slice(i, i + 200))
        if (error) throw new Error(`ME active-ask read failed: ${error.message}`)
        for (const r of (data ?? []) as Array<{ token_mint: string }>) meActive.add(r.token_mint)
      }
      const states = [...new Set(reported.map((r) => r.state))]
      const mePdas = new Set<string>()
      for (let i = 0; i < states.length; i += 200) {
        const { data, error } = await (supabaseAdmin as any)
          .from("candy_listings")
          .select("pda_address")
          .eq("venue", "magic_eden")
          .in("pda_address", states.slice(i, i + 200))
        if (error) throw new Error(`ME pda read failed: ${error.message}`)
        for (const r of (data ?? []) as Array<{ pda_address: string }>) mePdas.add(r.pda_address)
      }

      // ── 4. Build rows ─────────────────────────────────────────────────────
      let notCandy = 0
      let skippedMeActive = 0
      let matchedMePda = 0
      const rows: Record<string, unknown>[] = []
      const seenStates = new Set<string>()
      const nowIso = new Date().toISOString()
      for (const { l, mint, state } of reported) {
        if (mePdas.has(state)) matchedMePda++
        const key = keyByMint.get(mint)
        if (!key) {
          // Not a Candy CARD. Sealed packs are left to the Magic Eden route's
          // candy_pack_listings (no venue column there yet) — counted, not written.
          notCandy++
          continue
        }
        if (meActive.has(mint) || mePdas.has(state)) {
          skippedMeActive++
          continue
        }
        if (seenStates.has(state)) continue
        const price = osPrice(l.price?.current, rate)
        if (!price) {
          unpriced++
          continue
        }
        seenStates.add(state)
        found++
        rows.push({
          pda_address: state,
          token_mint: mint,
          edition_id: idByKey.get(key) ?? null,
          collection_id: CANDY_MLB_UUID,
          seller: l.svm_order?.maker ?? null,
          // The settling program, so the protocol vocabulary is measurable.
          auction_house: l.protocol_address ?? null,
          price_sol: price.sol,
          price_usd: price.usd,
          token_size: 1,
          expiry: null,
          last_seen_at: nowIso,
          is_active: true,
          venue: "opensea",
          venue_order_id: l.svm_order?.id ?? null,
        })
      }

      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any)
          .from("candy_listings")
          .upsert(batch, { onConflict: "pda_address" })
        if (error) {
          writeErrors.push(`candy_listings upsert: ${error.message}`)
          skipped += batch.length
        } else written += batch.length
      }

      // ── 5. Evidence-based retirement of OpenSea rows this sweep did not see ─
      // ⚠ Reads only rows last seen BEFORE this sweep, so nothing written above
      // can be retired by its own tick.
      let statusChecked = 0
      let statusUnknown = 0
      let statusTerminal = 0
      let retireCandidates: number | null = null
      const { data: stale, error: staleErr } = await (supabaseAdmin as any)
        .from("candy_listings")
        .select("pda_address, venue_order_id, auction_house")
        .eq("venue", "opensea")
        .eq("is_active", true)
        .lt("last_seen_at", startedAtIso)
        // ⚠ Oldest-first, so a row whose status lookup keeps failing stays at the
        // head. It cannot starve the pass until MORE than MAX_STATUS_CHECKS such
        // rows pile up; `status_unknown` in the run row is the watch for that.
        .order("last_seen_at", { ascending: true })
        .order("pda_address", { ascending: true })
        .limit(MAX_STATUS_CHECKS)
      if (staleErr) {
        writeErrors.push(`stale opensea read: ${staleErr.message}`)
      } else {
        retireCandidates = (stale ?? []).length
        const dead: string[] = []
        for (const r of (stale ?? []) as Array<{ pda_address: string; venue_order_id: string | null; auction_house: string | null }>) {
          if (Date.now() - startedMs > SWEEP_BUDGET_MS) break
          if (!r.venue_order_id || !r.auction_house) {
            statusUnknown++
            continue
          }
          try {
            const { json } = await osGet(
              `/orders/chain/solana/protocol/${encodeURIComponent(r.auction_house)}/${encodeURIComponent(r.venue_order_id)}`,
              apiKey,
            )
            statusChecked++
            const status = String(json?.order?.status ?? "")
            if (TERMINAL_STATUSES.has(status)) dead.push(r.pda_address)
          } catch {
            // No evidence → no retirement. A 404 is NOT read as "gone".
            statusUnknown++
          }
        }
        statusTerminal = dead.length
        for (let i = 0; i < dead.length; i += 200) {
          const { data: gone, error: goneErr } = await (supabaseAdmin as any)
            .from("candy_listings")
            .update({ is_active: false })
            .eq("venue", "opensea")
            .eq("is_active", true)
            .in("pda_address", dead.slice(i, i + 200))
            .lt("last_seen_at", startedAtIso)
            .select("pda_address")
          if (goneErr) writeErrors.push(`candy_listings retire: ${goneErr.message}`)
          else retired += (gone ?? []).length
        }
      }

      await logRun(
        startedAtIso,
        found,
        written,
        skipped,
        writeErrors.length === 0,
        writeErrors.length ? `${writeErrors.length} rejected write(s): ${writeErrors.slice(0, 3).join(" | ")}`.slice(0, 500) : null,
        {
          slug,
          slug_discovery: slugHow,
          sample_opensea_url: sampleUrl,
          raw_listings_seen: rawSeen,
          listings_found: found,
          listings_upserted: written,
          write_errors: writeErrors.length,
          not_active: notActive,
          no_identity: noIdentity,
          not_candy_card: notCandy,
          unpriced,
          skipped_me_active: skippedMeActive,
          matched_me_pda: matchedMePda,
          protocols,
          retire_candidates: retireCandidates,
          status_checked: statusChecked,
          status_unknown: statusUnknown,
          // Orders OpenSea called terminal; `retired` is how many rows that retired.
          status_terminal: statusTerminal,
          retired,
          sweep_complete: sweepComplete,
          budget_exhausted: budgetExhausted,
          pages_walked: pages,
          sol_usd: rate,
          duration_ms: Date.now() - startedMs,
        },
      )
    } catch (e) {
      await logRun(startedAtIso, found, written, skipped, false, e instanceof Error ? e.message : String(e), {
        slug,
        slug_discovery: slugHow,
        listings_found: found,
        listings_upserted: written,
        retired,
        sweep_complete: sweepComplete,
        pages_walked: pages,
        duration_ms: Date.now() - startedMs,
      })
    }
  })

  return NextResponse.json({ accepted: true, collection: CANDY_MLB_SLUG, started_at: startedAtIso }, { status: 202 })
}
