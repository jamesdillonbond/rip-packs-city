import { NextRequest, NextResponse } from "next/server"
import { lookupCachedTopShotUsername } from "@/lib/chains/flow/topshot-username-resolve"
import { supabaseAdmin } from "@/lib/supabase"
import {
  pinnacleSerialFmv,
  toMultiplierMap,
  type PinnacleMultiplierRow,
} from "@/lib/pinnacle/serial-fmv"
import { isSerialisedEditionType } from "@/lib/pinnacle/serialisation"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

// Aggregates the Disney Pinnacle wallet view: moments + totals + variant
// breakdown + franchise breakdown. Fronts the shared RPCs so the client
// only has to make a single call.

const PINNACLE_COLLECTION_UUID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

// Minimal structural type for the one table read this route makes, so the new
// call doesn't need the `as any` escape hatch the legacy .rpc() calls use.
type TableClient = {
  from: (table: string) => { select: (cols: string) => Promise<{ data: unknown; error: { message: string } | null }> }
}

// pinnacle_editions lookup used only to answer "is this edition type serialised?".
type EditionTypeClient = {
  from: (table: string) => {
    select: (cols: string) => {
      in: (col: string, vals: string[]) => Promise<{ data: unknown; error: { message: string } | null }>
    }
  }
}

/**
 * edition_key -> edition_type for the editions this wallet actually holds.
 *
 * WHY: most Pinnacle editions are not serialised at all, but the wallet RPC does
 * not carry edition_type, so the table rendered a bare em-dash for every holding
 * of an unserialised edition -- indistinguishable from "we failed to index the
 * serial". Serialisation is a property of the edition TYPE (measured 2026-08-02:
 * not one Pinnacle edition is mixed), so one small keyed lookup is enough to tell
 * the two apart. Kept in the route rather than pushed into
 * get_wallet_moments_with_fmv on purpose: that RPC is a hot cross-collection read
 * and this is a presentation concern.
 *
 * Fails SOFT -- on any error we return an empty map, every row falls back to
 * `edition_type: null`, and the table renders exactly as it does today.
 */
async function fetchEditionTypes(editionKeys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const keys = editionKeys.filter((k): k is string => typeof k === "string" && k.length > 0)
  if (keys.length === 0) return out
  // Chunked so the PostgREST request URL cannot blow its length cap on a big wallet.
  const CHUNK = 120
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK)
    try {
      const { data, error } = await boundedRead((supabaseAdmin as unknown as EditionTypeClient)
        .from("pinnacle_editions")
        .select("edition_key, edition_type")
        .in("edition_key", slice), "api/pinnacle-wallet/pinnacle_editions")
      if (error || !Array.isArray(data)) continue
      for (const row of data as Array<{ edition_key?: unknown; edition_type?: unknown }>) {
        if (typeof row?.edition_key === "string" && typeof row?.edition_type === "string") {
          out.set(row.edition_key, row.edition_type)
        }
      }
    } catch {
      // Soft-fail this chunk; the rows it would have covered stay "cannot say".
    }
  }
  return out
}

/** Coerce a jsonb field to a finite number, or null. Never NaN. */
function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function GET(req: NextRequest) {
  let wallet = req.nextUrl.searchParams.get("wallet")?.trim().toLowerCase() ?? ""
  if (!wallet) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 })
  }
  // 2026-09-06: the front door says "paste a Top Shot username"; this route
  // answered a username with `400 wallet param required`, which the Pinnacle
  // tab rendered verbatim as its error banner. Resolve through the same cached
  // ladder the Collection tab uses (a Flow address is chain-wide, so a Top Shot
  // username identifies the Pinnacle wallet too); an unresolved name is a 404
  // with copy a collector can act on, never a 400 that reads as our bug.
  if (!wallet.startsWith("0x")) {
    let resolved: string | null = null
    try {
      resolved = await lookupCachedTopShotUsername(supabaseAdmin as any, wallet)
    } catch (e) {
      return apiErrorResponse(e, "api/pinnacle-wallet/resolve-username")
    }
    if (!resolved) {
      return NextResponse.json(
        { error: "unresolved", message: "That Top Shot username is not in our index yet — try the 0x wallet address." },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      )
    }
    wallet = resolved.toLowerCase()
  }

  try {
    const [momentsRes, totalRes, variantsRes, franchisesRes, bestOfferRes, serialMultRes] = await Promise.all([
      boundedRead((supabaseAdmin as any).rpc("get_wallet_moments_with_fmv", {
        p_wallet: wallet,
        p_collection_id: PINNACLE_COLLECTION_UUID,
        p_limit: 500,
        p_offset: 0,
      }), "api/pinnacle-wallet/get_wallet_moments_with_fmv"),
      boundedRead((supabaseAdmin as any).rpc("get_pinnacle_wallet_total_fmv", { p_wallet: wallet }), "api/pinnacle-wallet/get_pinnacle_wallet_total_fmv"),
      boundedRead((supabaseAdmin as any).rpc("get_pinnacle_variant_breakdown", { p_wallet: wallet }), "api/pinnacle-wallet/get_pinnacle_variant_breakdown"),
      boundedRead((supabaseAdmin as any).rpc("get_pinnacle_franchise_breakdown", { p_wallet: wallet }), "api/pinnacle-wallet/get_pinnacle_franchise_breakdown"),
      boundedRead((supabaseAdmin as any).rpc("get_pinnacle_wallet_best_offer_total", { p_wallet: wallet }), "api/pinnacle-wallet/get_pinnacle_wallet_best_offer_total"),
      // Serial-premium bands. Top Shot and All Day holdings already carry a
      // serial-adjusted value; Pinnacle's fitted model existed and was refreshed
      // weekly but nothing on a wallet surface read it, so a #1 of a 500-mint
      // render was shown at the same value as #487. See lib/pinnacle/serial-fmv.ts.
      boundedRead((supabaseAdmin as unknown as TableClient).from("pinnacle_serial_fmv_multipliers").select("band, multiplier, is_reliable"), "api/pinnacle-wallet/pinnacle_serial_fmv_multipliers"),
    ])

    // ⚠ THE MOMENTS READ IS LOAD-BEARING AND ITS FAILURE IS NOT AN EMPTY WALLET.
    // Every other leg here is additive — a failed total renders `totalFmv: null`,
    // a failed breakdown renders no chips — but `moments` IS the page, and
    // answering `ok: true` with `moments: []` tells a collector this wallet holds
    // nothing. The per-leg `errors` object below has always carried the honest
    // signal on the wire; nothing obliged the client to read it, and the empty
    // array is the more legible of the two.
    //
    // Until 2026-09-04 this branch was unreachable for a RETURNED error — only a
    // THROWN one reached the catch below — so the swallow was real but rare.
    // Bounding these reads makes an overrun RESOLVE with an error rather than
    // hang, which is precisely the case that would have started rendering empty
    // wallets, so the guard ships with the bound rather than after it.
    if (momentsRes?.error) {
      return apiErrorResponse(momentsRes.error, "pinnacle-wallet", "Wallet data isn't available right now.")
    }
    const momentsJson = momentsRes?.data ?? {}
    const rawMoments = Array.isArray(momentsJson) ? momentsJson
      : Array.isArray(momentsJson?.moments) ? momentsJson.moments
      : Array.isArray(momentsJson?.data) ? momentsJson.data
      : []

    // Serial-adjusted value per holding. Additive ONLY: `fmv_usd` and every
    // total below are untouched, because the render FMV is what a TYPICAL serial
    // trades at and that remains the honest headline. `serial_fmv` is the same
    // key the Top Shot / All Day wallet rows carry, so the shape is now at
    // parity across collections. Null wherever the model declines to estimate
    // (unpriced render, no band, unreliable band, or mint below the display
    // guard) — never a fabricated number.
    //
    // Also normalise `mint_count`: the RPC emits `circulation_count`, and the
    // wallet table reads `mint_count`, so the "#serial/mint" denominator has
    // silently never rendered on this page.
    const serialMults = toMultiplierMap(serialMultRes?.data as PinnacleMultiplierRow[] | null)

    // Serialisation is per edition TYPE. Attaching it lets the wallet table say
    // "not serialised" instead of rendering a blank that reads as missing data.
    const editionTypes = await fetchEditionTypes(
      Array.from(new Set(rawMoments.map((m: Record<string, unknown>) =>
        typeof m?.edition_key === "string" ? m.edition_key : ""))).filter(Boolean) as string[]
    )

    const moments = rawMoments.map((m: Record<string, unknown>) => {
      const mint = num(m?.mint_count) ?? num(m?.circulation_count)
      const est = pinnacleSerialFmv(
        num(m?.serial_number),
        mint,
        num(m?.fmv_usd),
        serialMults,
        { applyMinMintGuard: true },
      )
      const editionType = typeof m?.edition_key === "string"
        ? editionTypes.get(m.edition_key) ?? null
        : null
      return {
        ...m,
        mint_count: mint,
        edition_type: editionType,
        // true / false / null, where null means "we cannot say" (unknown or new
        // edition type) and the table must fall back to its neutral rendering
        // rather than assert anything.
        is_serialised: isSerialisedEditionType(editionType),
        serial_fmv: est?.estimate ?? null,
        serial_band: est?.band ?? null,
        serial_mult: est?.multiplier ?? null,
      }
    })

    const totalJson = totalRes?.data ?? {}
    const totalFmv = typeof totalJson === "number" ? totalJson
      : typeof totalJson?.total_fmv === "number" ? totalJson.total_fmv
      : typeof totalJson?.fmv_total === "number" ? totalJson.fmv_total
      : null
    const momentCount = typeof totalJson?.moment_count === "number" ? totalJson.moment_count
      : typeof totalJson?.count === "number" ? totalJson.count
      : moments.length

    // get_pinnacle_variant_breakdown returns [{ variant: "<UPPERCASE TIER>", count, total_fmv }]
    // — the variant analogue of get_pinnacle_franchise_breakdown. The wallet page
    // expects { variant_type, count, total_fmv } and keys its colour/rank maps by
    // Title-Case names, so normalise the casing here. total_fmv now carries the real
    // per-variant FMV sum (grouped identically to the old counts RPC, so counts are
    // unchanged) instead of a hardcoded null — matching the franchise chips, which
    // already show it.
    const toTitleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    const variantsRaw = Array.isArray(variantsRes?.data) ? variantsRes.data : []
    const variants = variantsRaw.map((v: any) => ({
      variant_type: toTitleCase(String(v?.variant ?? "")),
      count: Number(v?.count) || 0,
      total_fmv: v?.total_fmv != null ? Number(v.total_fmv) : null,
    }))

    // get_pinnacle_franchise_breakdown returns [{ franchise, pin_count, total_fmv }];
    // the wallet page's FranchiseBucket expects `count`, not `pin_count`.
    const franchisesRaw = Array.isArray(franchisesRes?.data) ? franchisesRes.data : []
    const franchises = franchisesRaw.map((f: any) => ({
      franchise: f?.franchise ?? "Unknown",
      count: Number(f?.pin_count ?? f?.count) || 0,
      total_fmv: f?.total_fmv ?? null,
    }))

    // Pinnacle has no locking concept — every pin in wallet_moments_cache
    // for collection 7dd9dd11... has is_locked = false. Return null (not 0)
    // for lockedFmv + lockedCount so <WalletStatRow> renders em-dash with
    // an "n/a for this collection" caption rather than a misleading
    // "0 locked" caption.
    //
    // bestOfferTotal: sum of the best standing DapperOffersV2 bid per held pin,
    // via get_pinnacle_wallet_best_offer_total (marketplace_offers, DUC ~= USD).
    // No Pinnacle offer ingest exists yet, so this reads 0 today — we surface
    // null (not 0) to keep the tile honest, and it lights up automatically once
    // Pinnacle offers land in marketplace_offers. spreadGap = FMV − best offer.
    const bestOfferRaw = typeof bestOfferRes?.data === "number"
      ? bestOfferRes.data
      : Number(bestOfferRes?.data)
    const unlockedFmv = totalFmv
    const unlockedCount = momentCount
    const lockedFmv: number | null = null
    const lockedCount: number | null = null
    const bestOfferTotal: number | null =
      Number.isFinite(bestOfferRaw) && bestOfferRaw > 0 ? bestOfferRaw : null
    const spreadGap: number | null =
      totalFmv !== null && bestOfferTotal !== null ? totalFmv - bestOfferTotal : null

    return NextResponse.json({
      ok: true,
      wallet,
      moments,
      momentCount,
      totalFmv,
      unlockedFmv,
      unlockedCount,
      lockedFmv,
      lockedCount,
      bestOfferTotal,
      spreadGap,
      variants,
      franchises,
      errors: {
        moments: momentsRes?.error?.message ?? null,
        total: totalRes?.error?.message ?? null,
        variants: variantsRes?.error?.message ?? null,
        franchises: franchisesRes?.error?.message ?? null,
        bestOffer: bestOfferRes?.error?.message ?? null,
        serialMultipliers: serialMultRes?.error?.message ?? null,
      },
    })
  } catch (err) {
    return apiErrorResponse(err, "pinnacle-wallet", "Wallet data isn't available right now.")
  }
}
