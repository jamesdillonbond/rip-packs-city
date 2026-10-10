// app/api/panini-set-progress/route.ts
//
// Panini Sets tab backend (2026-09-27). Since 2026-10-10 it covers EVERY walked
// Panini product, ONE PRODUCT PER READ (?product=<setId>): the sets of that product
// from `panini_set_progress_all(p_username)` filtered on product_set_id, plus the
// product picker from `panini_set_progress_products(p_username)` (migrations
// 20261010223402 + 20261010223446). The all-product list is ~1,900 rows — past
// PostgREST's 1,000-row clamp — so it is never read whole: a clamped read would be a
// silently PARTIAL list. Each read here is asserted to sit under the clamp.
// Default product: with a username, the product RPC has seen them hold most of;
// otherwise 2026 Prizm World Cup (2332). An unknown ?product= is a 400, never
// another product's sets (a fallback that swaps the SUBJECT). The generic /api/sets-db cannot serve Panini: it keys on a
// wallet ADDRESS and on `editions` set membership, while a Panini owner is a
// USERNAME and Panini's set catalogue lives in `panini_editions`.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · Panini publishes NO checklist. Every count is editions RPC has SEEN (a card
//     of it has been listed), so "499 editions" is a floor on the set, not its
//     size. The tab carries the listing-gated coverage note for that reason.
//   · Cost to finish is the sum of today's lowest CONFIRMED asks (re-read in the
//     last 7 days) over the missing editions that have one. Editions with no such
//     ask are counted (`missingUnasked`) and never priced as $0 — the cost is a
//     floor too. The largest single ask is returned beside the total because the
//     total is concentrated (one Messi /10 ask was $100k of a $185k set).
//   · A username is matched case-insensitively (panini_card_serials.owner is 71%
//     mixed case; folding is collision-free). "Owned" means RPC has SEEN a serial
//     of that edition under the username on its last read — point-in-time, and
//     blind to cards never listed. The payload says when it last saw one.
//   · A malformed username is a 400 for the username, never an all-zero tracker.
//     A username RPC has never seen is `userSeen: false`, not "0 of 499 owned".
//   · A failed read is a 503 through `apiErrorResponse`, never an empty list.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { readPaniniCoverage } from "@/lib/panini/coverage"
import { normalizePaniniUsername } from "@/lib/profile/collector-identities"
import { parsePaniniSetRow, parsePaniniProductRow, PANINI_WC_SET_ID } from "@/lib/panini/set-progress"

export const dynamic = "force-dynamic"
export const maxDuration = 30

/** PostgREST clamps a read at 1,000 rows; a read that reaches it may be partial. */
const ROW_CLAMP = 1000
const FAIL = "Set progress is unavailable right now."

function bad(error: string) {
  return NextResponse.json({ error, code: "bad_request", retryable: false }, { status: 400 })
}

export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("username") ?? "").trim()
  let username: string | null = null
  if (raw) {
    username = normalizePaniniUsername(raw)
    if (!username) return bad("That doesn't look like a Panini username (2–16 letters, numbers, . _ -).")
  }
  const productRaw = (req.nextUrl.searchParams.get("product") ?? "").trim()
  let requested: number | null = null
  if (productRaw) {
    if (!/^[0-9]{1,6}$/.test(productRaw)) return bad("That isn't a Panini product id.")
    requested = Number(productRaw)
  }
  try {
    const db = supabaseAdmin as any
    const [prodRes, coverage] = await Promise.all([
      boundedRead(db.rpc("panini_set_progress_products", { p_username: username }), "panini-set-progress-products"),
      readPaniniCoverage(db, "api/panini-set-progress"),
    ])
    if (prodRes.error) return apiErrorResponse(prodRes.error, "api/panini-set-progress", FAIL)
    if (!Array.isArray(prodRes.data) || prodRes.data.length >= ROW_CLAMP) {
      return apiErrorResponse(new Error("panini_set_progress_products returned a non-array or a clamped list"), "api/panini-set-progress", FAIL)
    }
    const products = (prodRes.data as unknown[]).map(parsePaniniProductRow).filter((p): p is NonNullable<typeof p> => p !== null)
    if (products.length !== prodRes.data.length) {
      return apiErrorResponse(
        new Error(`panini_set_progress_products: ${prodRes.data.length - products.length} malformed row(s)`),
        "api/panini-set-progress",
        FAIL,
      )
    }
    const ownedTotal = products.reduce((n, p) => n + p.owned, 0)
    let selected = requested
    if (selected === null) {
      const mostHeld = username ? [...products].filter((p) => p.owned > 0).sort((a, b) => b.owned - a.owned || a.setId - b.setId)[0] : undefined
      selected = mostHeld?.setId ?? (products.some((p) => p.setId === PANINI_WC_SET_ID) ? PANINI_WC_SET_ID : products[0]?.setId ?? null)
    }
    const product = selected === null ? null : products.find((p) => p.setId === selected) ?? null
    if (requested !== null && !product) return bad("RPC hasn't seen any card of that Panini product.")

    let sets: NonNullable<ReturnType<typeof parsePaniniSetRow>>[] = []
    if (product) {
      const res = await boundedRead(
        db.rpc("panini_set_progress_all", { p_username: username }).eq("product_set_id", product.setId),
        "panini-set-progress",
      )
      if (res.error) return apiErrorResponse(res.error, "api/panini-set-progress", FAIL)
      if (!Array.isArray(res.data) || res.data.length >= ROW_CLAMP) {
        return apiErrorResponse(new Error("panini_set_progress_all returned a non-array or a clamped list"), "api/panini-set-progress", FAIL)
      }
      sets = (res.data as unknown[]).map(parsePaniniSetRow).filter((s): s is NonNullable<typeof s> => s !== null)
      // A malformed row is dropped by the parser; if ANY was, the list is not the
      // complete set list and must not be served as one.
      if (sets.length !== res.data.length) {
        return apiErrorResponse(
          new Error(`panini_set_progress_all: ${res.data.length - sets.length} malformed row(s)`),
          "api/panini-set-progress",
          FAIL,
        )
      }
      // The picker and the table come from the same function; a disagreement means one read is stale or partial.
      if (sets.length !== product.sets) {
        return apiErrorResponse(
          new Error(`panini_set_progress_all: ${sets.length} sets vs ${product.sets} in the product summary`),
          "api/panini-set-progress",
          FAIL,
        )
      }
    }
    const lastSeen = products.reduce<string | null>((m, p) => (p.ownerLastSeenAt && (!m || p.ownerLastSeenAt > m) ? p.ownerLastSeenAt : m), null)
    return NextResponse.json(
      {
        username,
        // Only meaningful with a username: did RPC ever see a card under it, in ANY product?
        userSeen: username ? ownedTotal > 0 : null,
        userLastSeenAt: username ? lastSeen : null,
        products,
        product,
        sets,
        coverage: coverage.ok ? coverage.coverage : null,
        coverage_error: !coverage.ok,
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": username ? "private, no-store" : "public, s-maxage=300, stale-while-revalidate=600" } },
    )
  } catch (err) {
    return apiErrorResponse(err, "api/panini-set-progress", FAIL)
  }
}
