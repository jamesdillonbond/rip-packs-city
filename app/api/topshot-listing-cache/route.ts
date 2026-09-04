import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── NBA Top Shot listing cache ────────────────────────────────────────────────
//
// Dedicated TS listing refresh via the Supabase flowty-proxy edge function.
// Mirrors allday/ufc/golazos pattern: GET returns immediately (accepted) and
// Vercel `after()` runs the paginated fetch + upsert in the background with
// maxDuration=300 so we don't hit the serverless function timeout on large
// page counts like the shared /api/listing-cache route does.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
// Vercel Cron sends ONLY `Authorization: Bearer $CRON_SECRET`, via GET — it cannot
// send INGEST_SECRET_TOKEN. Accepting both lets this route be driven by a Vercel
// cron (which delivers ~100% of ticks) as well as by GitHub Actions / cron-job.org
// / a manual curl. Same shape as app/api/candy-listings-indexer and
// app/api/cron/allday-lock-refresh-batch. Added 2026-08-01 with the GHA->Vercel
// move; see docs/operations/cron-schedule.md.
const CRON_TOKEN = process.env.CRON_SECRET ?? ""
const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TS_CONTRACT_ADDRESS = "0x0b2a3299cc857e29"
const TS_CONTRACT_NAME = "TopShot"
const FLOWTY_PROXY_URL =
  "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/flowty-proxy"
const FLOWTY_PROXY_TOKEN = process.env.FLOWTY_PROXY_TOKEN
if (!FLOWTY_PROXY_TOKEN) {
  throw new Error("FLOWTY_PROXY_TOKEN env var is required")
}
// Match the Pinnacle pattern: page size 100 + listingKind:sale filter so each
// Flowty page returns 100 actively-listed NFTs (not 100 raw NFTs that we then
// have to filter for state==='LISTED' client-side, which is what was capping
// the previous PAGE_LIMIT=50 runs at ~56 listings/run).
const PAGE_LIMIT = 100
const MAX_PAGES = 20
const INTER_PAGE_DELAY_MS = 200
const UPSERT_CHUNK = 50

const SERIES_NAMES: Record<number, string> = {
  0: "Series 1",
  2: "Series 2",
  3: "Summer 2021",
  4: "Series 3",
  5: "Series 4",
  6: "Series 2023-24",
  7: "Series 2024-25",
  8: "Series 2025-26",
}

type Trait = { name?: string; trait_type?: string; value?: unknown }

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function traitValue(traits: Trait[] | undefined, ...names: string[]): string | null {
  if (!traits) return null
  for (const name of names) {
    const hit = traits.find((t) => t?.name === name || t?.trait_type === name)
    if (hit && hit.value !== null && hit.value !== undefined) {
      const s = String(hit.value).trim()
      if (s) return s
    }
  }
  return null
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

async function fetchPage(
  offset: number
): Promise<{ status: number; nfts?: any[]; total?: number; errorText?: string }> {
  // 30s cap. `fetch()` has NO default timeout and this runs inside an `after()`
  // body under maxDuration 300, so one upstream holding the connection open
  // consumes the whole tick — and a maxDuration kill writes NO terminal
  // pipeline_runs row, leaving the outage invisible ("the cron never fired").
  // Same class that cost the candy board a 44h blackout (2026-08-27).
  //
  // ⚠ NO whole-loop deadline here, deliberately. Measured over 48h these caches
  // ran 142/142 ok — they are FINISHING, so a budget could only truncate healthy
  // runs. ⓘ Their maxes (topshot 361.5s, allday 344.3s) EXCEED the declared 300s
  // ceiling, the same Fluid Compute overrun seen on candy-listings — which is
  // precisely why a deadline must never be sized off the config value.
  const res = await fetch(FLOWTY_PROXY_URL, {
    signal: AbortSignal.timeout(30_000),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FLOWTY_PROXY_TOKEN}`,
    },
    body: JSON.stringify({
      contractAddress: TS_CONTRACT_ADDRESS,
      contractName: TS_CONTRACT_NAME,
      // listingKind: "sale" forces Flowty to return only NFTs with active sale
      // listings; without it, the proxy was returning a mix of listed/unlisted
      // NFTs and the loop hit the "no new flow_ids" early-break after 1-2 pages.
      payload: { filters: { listingKind: "sale" }, offset, limit: PAGE_LIMIT },
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    return { status: res.status, errorText: text.slice(0, 200) }
  }
  const body = (await res.json()) as { nfts?: any[]; total?: number }
  return { status: res.status, nfts: body?.nfts, total: body?.total }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  const okIngest = Boolean(TOKEN) && (bearer === TOKEN || urlToken === TOKEN)
  const okCron = Boolean(CRON_TOKEN) && bearer === CRON_TOKEN
  if (!okIngest && !okCron) return unauthorized()

  after(() => runListingCache())

  return NextResponse.json({
    status: "accepted",
    message: "topshot-listing-cache started in background via after()",
    startedAt: new Date().toISOString(),
  })
}

const PIPELINE_NAME = "topshot-listing-cache"
const COLLECTION_SLUG = "nba_top_shot"

async function runListingCache() {
  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  const stats = {
    ok: true,
    errorMsg: null as string | null,
    totalFetched: 0,
    totalListed: 0,
    upserted: 0,
    upsertErrors: 0,
    fmvRecalcCalled: false,
    // Stage counters — hoisted out of the inner try so the finally-scoped
    // log_pipeline_run call can fold them into pipeline_runs.extra.
    pagesFetched: 0,
    skipNoListedOrder: 0,
    skipMissingId: 0,
    skipMissingResourceID: 0,
    skipMissingPlayerName: 0,
    skipDuplicateInRun: 0,
    dedupedRows: 0,
    purgedRows: 0,
    purgeSkipped: false,
    headCountAfterPurge: null as number | null,
    // ⚠ COMPLETENESS, not row counts. The loop below `break`s identically on a
    // legitimate end-of-book and on an upstream failure, and the stale purge
    // that follows deletes every row this run did not re-write. Without this
    // flag a truncated sweep is indistinguishable from a complete one and the
    // purge turns a transient Flowty error into a DELETE of live listings.
    // CLAUDE.md: "a PAGED read that `break`s on error returns a PARTIAL list no
    // caller can distinguish from a complete one" — carry `complete`.
    sweepComplete: false,
    pageErrors: 0,
    sweepError: null as string | null,
  }

  try {

  type Row = {
    id: string
    flow_id: string
    moment_id: string | null
    player_name: string | null
    team_name: string | null
    set_name: string | null
    series_name: string | null
    tier: string | null
    serial_number: number | null
    circulation_count: number | null
    ask_price: number | null
    fmv: number | null
    source: string
    buy_url: string
    thumbnail_url: string | null
    listing_resource_id: string
    storefront_address: string | null
    is_locked: boolean
    listed_at: string | null
    cached_at: string
    collection_id: string
  }

  const rows: Row[] = []
  const seenFlowIds = new Set<string>()
  // Tolerate a single page where every flow_id was already seen (can happen if
  // Flowty briefly returns overlapping windows); only abort after two such
  // pages in a row. Bare empty pages still break immediately.
  let consecutiveStaleSeenPages = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_LIMIT
    const pageResp = await fetchPage(offset).catch((err) => {
      console.log(`[topshot-listing-cache] Page offset=${offset} failed: ${String(err)}`)
      return null
    })
    if (!pageResp) {
      stats.pageErrors++
      stats.sweepError = `page ${page} (offset ${offset}) fetch threw`
      break
    }
    const rawRows = pageResp.nfts
    if (pageResp.status >= 400) {
      console.log(
        `[topshot-listing-cache] non_ok_status status=${pageResp.status} errorText=${pageResp.errorText ?? ""}`
      )
      stats.pageErrors++
      stats.sweepError = `page ${page} (offset ${offset}) returned HTTP ${pageResp.status}`
      break
    }
    const nfts = Array.isArray(rawRows) ? rawRows : []
    stats.totalFetched += nfts.length
    stats.pagesFetched++
    console.log(
      `[topshot-listing-cache] stage=fetched page=${page} offset=${offset} fetched=${nfts.length} reportedTotal=${
        typeof pageResp.total === "number" ? pageResp.total : "null"
      }`
    )
    if (nfts.length === 0) {
      stats.sweepComplete = true
      break
    }
    const reportedTotal = typeof pageResp.total === "number" ? pageResp.total : null
    const prevSeenSize = seenFlowIds.size
    const beforeRowsCount = rows.length

    for (const nft of nfts) {
      const orders = Array.isArray(nft?.orders) ? nft.orders : []
      const listedOrder = orders.find((o: any) => o?.state === "LISTED")
      if (!listedOrder) {
        stats.skipNoListedOrder++
        continue
      }
      const nftIdRaw = nft?.id ?? nft?.nftId
      if (nftIdRaw === undefined || nftIdRaw === null) {
        stats.skipMissingId++
        continue
      }
      const nftIdStr = String(nftIdRaw)
      if (seenFlowIds.has(nftIdStr)) {
        stats.skipDuplicateInRun++
        continue
      }
      const listingResourceID = listedOrder.listingResourceID
      if (!listingResourceID) {
        stats.skipMissingResourceID++
        continue
      }

      let traits: Trait[] = []
      const rawTraits = nft?.nftView?.traits
      if (Array.isArray(rawTraits)) traits = rawTraits
      else if (rawTraits && Array.isArray(rawTraits.traits)) traits = rawTraits.traits

      const seriesStr = traitValue(traits, "SeriesNumber", "seriesNumber", "Series Number")
      const seriesNum = seriesStr !== null ? parseInt(seriesStr, 10) : null
      const tierRaw = traitValue(traits, "Tier", "Moment Tier", "tier")
      const teamName = traitValue(traits, "TeamAtMoment", "Team", "teamAtMoment", "teamName")
      const setName = traitValue(traits, "SetName", "Set Name", "setName")
      const rawTitle = nft?.card?.title ? String(nft.card.title).trim() : null
      // ⚠ Flowty answers with a PLACEHOLDER title — literally `TopShot #<nftId>` — for any NFT
      // whose metadata it has not resolved, and it sends no traits with it. That title is truthy,
      // so it used to sail through the `!playerName` guard and land a row that looked like a
      // Moment and was fabricated end to end. Measured 2026-09-04 over the whole population, not a
      // sample: 70 of 104 live Top Shot rows were placeholders, and for 70 OF 70 —
      //   • `card.num` was the NFT ID, written into `serial_number` (a serial nobody has),
      //   • `card.max` was absent, so circulation was NULL,
      //   • the tier trait was absent and the `?? "COMMON"` default supplied one,
      //   • Flowty's blended valuation still landed in `fmv`, and on 9 of them the ask was BELOW
      //     it, so the row rendered as a discount on an NFT we cannot identify.
      // The published consequence: `/api/profile/market-pulse` groups `cached_listings` by tier and
      // takes the lowest ask, so the Top Shot "Common floor" a collector saw was **$0.19 from an
      // assumed tier** — the real resolved COMMON floor is $0.20.
      // Compared against THIS nft's own id, not a loose `/^TopShot #\d+$/`, so a genuine title
      // that happens to look like one can never be discarded.
      const isUnidentified = rawTitle !== null && rawTitle === `TopShot #${nftIdStr}`
      const playerName =
        (isUnidentified ? null : rawTitle) ||
        traitValue(
          traits,
          "PlayerKnownName",
          "PlayerJerseyName",
          "Full Name",
          "Player Name",
          "playerName"
        ) ||
        rawTitle

      if (!playerName) {
        stats.skipMissingPlayerName++
        continue
      }

      // On an unidentified NFT every card.* field is unreliable (card.num was the NFT id in 70 of
      // 70), so the row keeps only what is actually true of it — the listing — and states the rest
      // as unknown. NULL is a worse-looking cell and a truthful one; a made-up serial is neither.
      const serial = isUnidentified
        ? null
        : toNumber(nft?.card?.num) ??
          toNumber(traitValue(traits, "serialNumber", "SerialNumber"))
      const circulation = isUnidentified
        ? null
        : toNumber(nft?.card?.max) ??
          toNumber(traitValue(traits, "numMoments", "maxEditionSize"))

      const thumbnail = nft?.card?.images?.[0]?.url ?? null
      const askPrice = toNumber(listedOrder.salePrice) ?? toNumber(listedOrder.usdValue)
      const rawFmv = toNumber(listedOrder.valuations?.blended?.usdValue)
      // A valuation is a claim about a specific Moment. With no identity there is nothing for it
      // to be a valuation OF, and carrying it is what turned 9 of these rows into "discounts".
      const fmv = !isUnidentified && rawFmv && rawFmv > 0 ? rawFmv : null
      const storefrontAddress =
        listedOrder.storefrontAddress ?? listedOrder.providerAddress ?? null
      const ts = listedOrder.blockTimestamp
      let listedAt: string | null = null
      if (ts !== null && ts !== undefined) {
        const ms = typeof ts === "number" ? ts : parseFloat(String(ts))
        if (Number.isFinite(ms)) listedAt = new Date(ms).toISOString()
      }

      const seriesName =
        seriesNum !== null && !isNaN(seriesNum)
          ? SERIES_NAMES[seriesNum] ?? `Series ${seriesNum}`
          : seriesStr

      const momentId = nft?.nftView?.uuid ? String(nft.nftView.uuid) : null

      const buyUrl = `https://www.flowty.io/asset/${TS_CONTRACT_ADDRESS}/${TS_CONTRACT_NAME}/NFT/${nftIdStr}?listingResourceID=${listingResourceID}`

      seenFlowIds.add(nftIdStr)
      rows.push({
        id: String(listingResourceID),
        flow_id: nftIdStr,
        moment_id: momentId,
        player_name: playerName,
        team_name: teamName,
        set_name: setName,
        series_name: seriesName,
        tier: tierRaw ? tierRaw.toUpperCase() : null,
        serial_number: serial,
        circulation_count: circulation,
        ask_price: askPrice,
        fmv,
        source: "flowty",
        buy_url: buyUrl,
        thumbnail_url: thumbnail,
        listing_resource_id: String(listingResourceID),
        storefront_address: storefrontAddress,
        is_locked: false,
        listed_at: listedAt,
        cached_at: new Date().toISOString(),
        collection_id: TS_COLLECTION_ID,
      })
    }

    const pageRowsAdded = rows.length - beforeRowsCount
    console.log(
      `[topshot-listing-cache] stage=parsed page=${page} pageRowsAdded=${pageRowsAdded} runRowsTotal=${rows.length} seenFlowIds=${seenFlowIds.size}`
    )
    // ── The three LEGITIMATE ends of the book. Each one means "there is
    //    nothing further to read", so the set in `rows` is complete and the
    //    stale purge below is safe. Anything that leaves this loop WITHOUT
    //    setting the flag (a fetch error above, or exhausting MAX_PAGES) is a
    //    truncation, and a truncated set must never drive a delete.
    if (nfts.length < PAGE_LIMIT) {
      stats.sweepComplete = true
      break
    }
    if (seenFlowIds.size === prevSeenSize) {
      consecutiveStaleSeenPages++
      if (consecutiveStaleSeenPages >= 2) {
        stats.sweepComplete = true
        break
      }
    } else {
      consecutiveStaleSeenPages = 0
    }
    if (reportedTotal !== null && offset + PAGE_LIMIT >= reportedTotal) {
      stats.sweepComplete = true
      break
    }
    await delay(INTER_PAGE_DELAY_MS)
  }
  if (!stats.sweepComplete && stats.sweepError === null) {
    stats.sweepError = `walked all ${MAX_PAGES} pages without reaching the end of the book`
  }

  stats.totalListed = rows.length
  console.log(
    `[topshot-listing-cache] stage=parse-summary pagesFetched=${stats.pagesFetched} totalFetched=${stats.totalFetched} parsed=${rows.length} skipNoListedOrder=${stats.skipNoListedOrder} skipMissingId=${stats.skipMissingId} skipMissingResourceID=${stats.skipMissingResourceID} skipMissingPlayerName=${stats.skipMissingPlayerName} skipDuplicateInRun=${stats.skipDuplicateInRun}`
  )

  // Dedup by flow_id before upsert. onConflict: 'flow_id' rejects the whole
  // batch when two VALUES rows share the conflict key, and the Flowty sweep
  // can surface the same nftId under different listing_resource_ids across
  // sorted pages. Keep the row with the lower ask_price per flow_id.
  const byFlowId = new Map<string, Row>()
  for (const row of rows) {
    const prev = byFlowId.get(row.flow_id)
    if (!prev) {
      byFlowId.set(row.flow_id, row)
      continue
    }
    const prevAsk = prev.ask_price
    const nextAsk = row.ask_price
    if (nextAsk != null && (prevAsk == null || nextAsk < prevAsk)) {
      byFlowId.set(row.flow_id, row)
    }
  }
  const dedupedRows = Array.from(byFlowId.values())
  stats.dedupedRows = dedupedRows.length
  console.log(
    `[topshot-listing-cache] stage=deduped parsedRows=${rows.length} dedupedRows=${dedupedRows.length} flowIdCollisions=${rows.length - dedupedRows.length}`
  )

  const runStartedAt = new Date(startedAt).toISOString()

  for (let i = 0; i < dedupedRows.length; i += UPSERT_CHUNK) {
    const batch = dedupedRows.slice(i, i + UPSERT_CHUNK)
    const { error, count } = await supabaseAdmin
      .from("cached_listings")
      .upsert(batch, { onConflict: "flow_id", count: "exact" })
    if (error) {
      console.log(`[topshot-listing-cache] upsert batch ${i} failed: ${error.message}`)
      stats.upsertErrors += batch.length
    } else {
      stats.upserted += count ?? batch.length
    }
  }
  console.log(
    `[topshot-listing-cache] stage=written upserted=${stats.upserted} upsertErrors=${stats.upsertErrors}`
  )

  // Only purge stale rows if at least one new row was successfully upserted
  // AND the sweep actually reached the end of the book, so neither a failed
  // Flowty fetch nor a truncated one wipes listings this run simply never saw.
  // ⚠ `upserted > 0` alone was NOT enough: a sweep that reads page 0 and then
  // errors on page 1 satisfies it while holding a partial book, and the purge
  // then deletes every listing that lived on the pages it never reached.
  if (stats.upserted > 0 && stats.sweepComplete) {
    const { error: delErr, count: delCount } = await supabaseAdmin
      .from("cached_listings")
      .delete({ count: "exact" })
      .eq("source", "flowty")
      .eq("collection_id", TS_COLLECTION_ID)
      .lt("cached_at", runStartedAt)
    if (delErr) {
      console.log(`[topshot-listing-cache] stale purge error: ${delErr.message}`)
    } else {
      stats.purgedRows = delCount ?? 0
    }
  } else {
    stats.purgeSkipped = true
  }
  const { count: postPurgeCount } = await supabaseAdmin
    .from("cached_listings")
    .select("*", { count: "exact", head: true })
    .eq("source", "flowty")
    .eq("collection_id", TS_COLLECTION_ID)
  stats.headCountAfterPurge = postPurgeCount ?? null
  console.log(
    `[topshot-listing-cache] stage=purged purgedRows=${stats.purgedRows} purgeSkipped=${stats.purgeSkipped} sweepComplete=${stats.sweepComplete} pageErrors=${stats.pageErrors} postPurgeRows=${postPurgeCount ?? "?"} runStartedAt=${runStartedAt}`
  )

  try {
    const recalcUrl = `${process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"}/api/fmv-recalc`
    // fmv-recalc runs its work in after() and answers immediately, so this is a
    // TRIGGER call — 30s bounds a hang without waiting on the recalc itself.
    const res = await fetch(recalcUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    })
    stats.fmvRecalcCalled = res.ok
    if (!res.ok) {
      console.log(`[topshot-listing-cache] fmv-recalc HTTP ${res.status}`)
    }
  } catch (err) {
    console.log(`[topshot-listing-cache] fmv-recalc threw: ${String(err)}`)
  }

  // Wallet-verification fallback: any unresolved listing-amount challenge
  // whose challenge_amount now appears in cached_listings for the claimed
  // wallet gets flipped to verified by this RPC. Cheap, idempotent.
  //
  // ⚠ CORRECTED 2026-08-11 — DO NOT DELETE THIS ON THE OLD NOTE'S REASONING.
  // The 2026-06-07 note here said this matcher "is effectively a no-op —
  // cached_listings is frozen (Flowty shut 2026-05-13) so it can never find a new
  // match", and pre-authorized deleting it with the frozen-Flowty teardown. The
  // PREMISE IS FALSE: Flowty shut its FRONTEND, but api2.flowty.io is alive and
  // this very route still writes cached_listings. Measured live 2026-08-12:
  // 309 rows, newest cached_at minutes old. So the table is warm and a match IS
  // reachable — deleting this would drop a working fallback, not dead code.
  //
  // What IS true: it has never actually fired. All 9 wallet_verification_challenges
  // rows resolved `expired` (8) or `gql_on_demand` (1), because the on-demand
  // /api/profile/verify-challenge/check route (direct topshot-proxy GQL) is the
  // primary path and gets there first. That makes this a cheap idempotent
  // BACKSTOP for a user who lists but never revisits the check page — which is
  // exactly the case the primary path cannot serve. Keep it.
  try {
    const { data: resolved, error: resolveErr } = await supabaseAdmin.rpc(
      "resolve_wallet_verification_challenges"
    )
    if (resolveErr) {
      console.log(`[topshot-listing-cache] verify resolver: ${resolveErr.message}`)
    } else {
      const count = Array.isArray(resolved) ? resolved.length : 0
      if (count > 0) console.log(`[topshot-listing-cache] resolved ${count} wallet challenges`)
    }
  } catch (err) {
    console.log(`[topshot-listing-cache] verify resolver threw: ${String(err)}`)
  }

  } catch (err) {
    stats.ok = false
    stats.errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`[topshot-listing-cache] fatal: ${stats.errorMsg}`)
  } finally {
    // A truncated sweep is a DEGRADED run, not a clean one — the purge above is
    // skipped, so `cached_listings` silently drifts toward holding delisted
    // rows. Report it as a failure (the `ingest/candy-offers` `degradedSweep`
    // precedent) instead of hiding it behind a healthy-looking `upserted`.
    // A real fatal error keeps precedence over the degradation message.
    const degradedSweep = !stats.sweepComplete
    const okFinal = stats.ok && !degradedSweep
    const errorFinal =
      stats.errorMsg ??
      (degradedSweep
        ? `sweep incomplete: ${stats.sweepError ?? "unknown truncation"} — stale purge skipped, cache may hold delisted rows`
        : null)
    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAtIso,
        p_rows_found: stats.totalListed,
        p_rows_written: stats.upserted,
        p_rows_skipped: stats.upsertErrors,
        p_ok: okFinal,
        p_error: errorFinal,
        p_collection_slug: COLLECTION_SLUG,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: {
          total_fetched: stats.totalFetched,
          fmv_recalc_called: stats.fmvRecalcCalled,
          duration_ms: Date.now() - startedAt,
          fetched: stats.totalFetched,
          parsed: stats.totalListed,
          deduped: stats.dedupedRows,
          written: stats.upserted,
          purged: stats.purgedRows,
          purge_skipped: stats.purgeSkipped,
          head_count_after_purge: stats.headCountAfterPurge,
          // The field an observer keys on. `purge_skipped` alone conflates
          // "nothing was written" with "the book was truncated"; these two
          // separate them, so the incidence of a truncated sweep is countable.
          sweep_complete: stats.sweepComplete,
          page_errors: stats.pageErrors,
          pages_fetched: stats.pagesFetched,
          skip_no_listed_order: stats.skipNoListedOrder,
          skip_missing_id: stats.skipMissingId,
          skip_missing_resource_id: stats.skipMissingResourceID,
          skip_missing_player_name: stats.skipMissingPlayerName,
          skip_duplicate_in_run: stats.skipDuplicateInRun,
        },
      })
    } catch (e) {
      console.log(
        `[topshot-listing-cache] log_pipeline_run err: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
    console.log(
      `[topshot-listing-cache] done: ${JSON.stringify({
        ...stats,
        durationMs: Date.now() - startedAt,
      })}`
    )
  }
}
