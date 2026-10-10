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
// ── PACKS AND LINKS (added 2026-10-10, same day) ─────────────────────────────
// Sealed-PACK asks (mints in candy_packs) are written to candy_pack_listings with
// venue='opensea', deduped against Magic Eden pack asks the same way. Each new
// OpenSea ask stores the item URL OpenSea itself returns (venue_url), fetched
// once and bounded per tick; RPC never builds a Solana OpenSea URL.
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
import {
  OS_PAGE_LIMIT,
  OS_TERMINAL_STATUSES,
  discoverCandyOpenSeaSlug,
  fetchOpenSeaItemUrl,
  fetchOrderStatus,
  openSeaApiKey,
  orderMint,
  osGet,
  osPrice,
  type OsOrder,
  type OsPrice,
} from "@/lib/chains/solana/opensea"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-opensea-listings-indexer"
// 50 x 200 = 10,000 asks — far above the whole Candy book (~1,500 active on ME),
// so a cursor that ends is what ends the sweep, not this cap.
const MAX_PAGES = 50
// Whole-sweep budget, under the 300 s wall so `logRun` always gets to run.
const SWEEP_BUDGET_MS = 240_000
// Bound on per-order status lookups per tick (the retirement pass). The rest
// wait for the next tick — no evidence means no retirement, never the reverse.
const MAX_STATUS_CHECKS = 150
// Bound on OpenSea item-URL lookups per tick (only asks with no stored URL).
const MAX_URL_FETCHES = 60

type OsListing = OsOrder & { price?: { current?: OsPrice } }

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

  const apiKey = openSeaApiKey()
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
    let packWritten = 0
    let packRetired = 0
    let sweepComplete = false
    let budgetExhausted = false
    let pages = 0
    let slug: string | null = null
    let slugHow: string | null = null
    let sampleUrl: string | null = null
    const writeErrors: string[] = []
    try {
      const d = await discoverCandyOpenSeaSlug(supabaseAdmin, apiKey)
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
        const qs = `limit=${OS_PAGE_LIMIT}${next ? `&next=${encodeURIComponent(next)}` : ""}`
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
          const mint = orderMint(l)
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

      // ── 3. Mints that are not cards may be sealed PACKS (candy_packs) ────
      const notCardMints = mints.filter((m) => !keyByMint.has(m))
      const packMints = new Set<string>()
      for (let i = 0; i < notCardMints.length; i += 200) {
        const { data, error } = await (supabaseAdmin as any)
          .from("candy_packs")
          .select("token_mint")
          .in("token_mint", notCardMints.slice(i, i + 200))
        if (error) throw new Error(`candy_packs batch lookup failed: ${error.message}`)
        for (const r of (data ?? []) as Array<{ token_mint: string }>) packMints.add(r.token_mint)
      }

      // ── 4. Dedup against the Magic Eden book (cards AND packs) ────────────
      const states = [...new Set(reported.map((r) => r.state))]
      const meActive = new Set<string>()
      const mePdas = new Set<string>()
      for (const [table, tableMints] of [
        ["candy_listings", mints.filter((m) => keyByMint.has(m))],
        ["candy_pack_listings", [...packMints]],
      ] as const) {
        for (let i = 0; i < tableMints.length; i += 200) {
          const { data, error } = await (supabaseAdmin as any)
            .from(table)
            .select("token_mint")
            .eq("venue", "magic_eden")
            .eq("is_active", true)
            .in("token_mint", tableMints.slice(i, i + 200))
          if (error) throw new Error(`ME active-ask read failed (${table}): ${error.message}`)
          for (const r of (data ?? []) as Array<{ token_mint: string }>) meActive.add(r.token_mint)
        }
        for (let i = 0; i < states.length; i += 200) {
          const { data, error } = await (supabaseAdmin as any)
            .from(table)
            .select("pda_address")
            .eq("venue", "magic_eden")
            .in("pda_address", states.slice(i, i + 200))
          if (error) throw new Error(`ME pda read failed (${table}): ${error.message}`)
          for (const r of (data ?? []) as Array<{ pda_address: string }>) mePdas.add(r.pda_address)
        }
      }

      // ── 5. Build rows ─────────────────────────────────────────────────────
      let notCandy = 0
      let skippedMeActive = 0
      let matchedMePda = 0
      const rows: Record<string, unknown>[] = []
      const packRows: Record<string, unknown>[] = []
      const contractByState = new Map<string, string>()
      const seenStates = new Set<string>()
      const nowIso = new Date().toISOString()
      for (const { l, mint, state } of reported) {
        if (mePdas.has(state)) matchedMePda++
        const key = keyByMint.get(mint)
        const isPackAsk = !key && packMints.has(mint)
        if (!key && !isPackAsk) {
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
        if (l.asset?.contract) contractByState.set(state, l.asset.contract)
        const common = {
          pda_address: state,
          token_mint: mint,
          collection_id: CANDY_MLB_UUID,
          seller: l.svm_order?.maker ?? null,
          // The settling program, so the protocol vocabulary is measurable.
          auction_house: l.protocol_address ?? null,
          price_sol: price.sol,
          price_usd: price.usd,
          expiry: null,
          last_seen_at: nowIso,
          is_active: true,
          venue: "opensea",
          venue_order_id: l.svm_order?.id ?? null,
        }
        if (isPackAsk) {
          packRows.push(common)
        } else {
          found++
          rows.push({ ...common, edition_id: idByKey.get(key as string) ?? null, token_size: 1 })
        }
      }

      // ── 6. OpenSea's own item link, fetched once per ask ──────────────────
      // A row that already holds a verified URL keeps it; a new one is asked of
      // OpenSea (bounded). A failed fetch leaves NULL, which the market arm
      // renders as no buy link rather than a guessed one.
      let urlsFetched = 0
      let urlsMissing = 0
      for (const [table, list] of [
        ["candy_listings", rows],
        ["candy_pack_listings", packRows],
      ] as const) {
        const have = new Map<string, string>()
        const ids = list.map((r) => r.pda_address as string)
        for (let i = 0; i < ids.length; i += 200) {
          const { data, error } = await (supabaseAdmin as any)
            .from(table)
            .select("pda_address, venue_url")
            .eq("venue", "opensea")
            .in("pda_address", ids.slice(i, i + 200))
          if (error) throw new Error(`venue_url read failed (${table}): ${error.message}`)
          for (const r of (data ?? []) as Array<{ pda_address: string; venue_url: string | null }>) {
            if (r.venue_url) have.set(r.pda_address, r.venue_url)
          }
        }
        for (const r of list) {
          const state = r.pda_address as string
          let url = have.get(state) ?? null
          const contract = contractByState.get(state)
          if (!url && contract && urlsFetched < MAX_URL_FETCHES && Date.now() - startedMs <= SWEEP_BUDGET_MS) {
            urlsFetched++
            url = await fetchOpenSeaItemUrl(contract, r.token_mint as string, apiKey)
          }
          if (!url) urlsMissing++
          r.venue_url = url
        }
      }

      for (const [table, list] of [
        ["candy_listings", rows],
        ["candy_pack_listings", packRows],
      ] as const) {
        for (let i = 0; i < list.length; i += 100) {
          const batch = list.slice(i, i + 100)
          const { error } = await (supabaseAdmin as any)
            .from(table)
            .upsert(batch, { onConflict: "pda_address" })
          if (error) {
            writeErrors.push(`${table} upsert: ${error.message}`)
            skipped += batch.length
          } else if (table === "candy_listings") written += batch.length
          else packWritten += batch.length
        }
      }

      // ── 7. Evidence-based retirement of OpenSea rows this sweep did not see ─
      // ⚠ Reads only rows last seen BEFORE this sweep, so nothing written above
      // can be retired by its own tick.
      let statusChecked = 0
      let statusUnknown = 0
      let statusTerminal = 0
      let retireCandidates: number | null = 0
      for (const table of ["candy_listings", "candy_pack_listings"] as const) {
        const { data: stale, error: staleErr } = await (supabaseAdmin as any)
          .from(table)
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
          writeErrors.push(`stale opensea read (${table}): ${staleErr.message}`)
          retireCandidates = null
          continue
        }
        if (retireCandidates != null) retireCandidates += (stale ?? []).length
        const dead: string[] = []
        for (const r of (stale ?? []) as Array<{ pda_address: string; venue_order_id: string | null; auction_house: string | null }>) {
          if (Date.now() - startedMs > SWEEP_BUDGET_MS) break
          if (!r.venue_order_id || !r.auction_house) {
            statusUnknown++
            continue
          }
          const status = await fetchOrderStatus(r.auction_house, r.venue_order_id, apiKey)
          if (status == null) {
            // No evidence → no retirement. A 404 is NOT read as "gone".
            statusUnknown++
            continue
          }
          statusChecked++
          if (OS_TERMINAL_STATUSES.has(status)) dead.push(r.pda_address)
        }
        statusTerminal += dead.length
        for (let i = 0; i < dead.length; i += 200) {
          const { data: gone, error: goneErr } = await (supabaseAdmin as any)
            .from(table)
            .update({ is_active: false })
            .eq("venue", "opensea")
            .eq("is_active", true)
            .in("pda_address", dead.slice(i, i + 200))
            .lt("last_seen_at", startedAtIso)
            .select("pda_address")
          if (goneErr) writeErrors.push(`${table} retire: ${goneErr.message}`)
          else if (table === "candy_listings") retired += (gone ?? []).length
          else packRetired += (gone ?? []).length
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
          pack_asks_upserted: packWritten,
          pack_asks_retired: packRetired,
          urls_fetched: urlsFetched,
          urls_missing: urlsMissing,
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
