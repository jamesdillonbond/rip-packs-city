// app/api/public/special-serial-owners/route.ts
//
// Backing JSON for the Special Serial Owners board. Returns the current
// tracked-wallet holder of every canonical Top Shot special serial (#1 mint,
// perfect mint #N/N, jersey-match serial) via the SECDEF RPC
// get_special_serial_owners_board, which the route calls through the
// service-role client (the view it reads, topshot_special_serial_owners, is not
// anon/authenticated-readable).
//
// Lives under /api/public/* so the proxy.ts allowlist lets the route through;
// it is the service-role caller of the RPC. NOTE: the PAGE (/special-serial-
// owners) is auth-gated (Trevor's 2026-06-19 holder-exposure decision) — it is
// NOT in proxy.ts isPublicPath and NOT in app/sitemap.ts. To flip the board
// fully public later, add /special-serial-owners to isPublicPath (GET/HEAD) +
// app/sitemap.ts; no change is needed here.
//
// Query params:
//   tag=#1|perfect|jersey                            (400 on invalid)
//   tier=COMMON|RARE|FANDOM|LEGENDARY|ULTIMATE        (400 on invalid)
//   player=<ilike substring>
//   holder=<exact wallet address>
//   sort=fmv|recent                                  default fmv
//   limit=<1..200>                                   default 100
//   offset=<>=0>                                     default 0
//
// Response: { meta: { fetched_at, source, total_rows, elapsed_ms, filters }, rows }
// CACHE: 15-min s-maxage (the view is live; this bounds load).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import {
  fetchSpecialSerialOwners,
  VALID_TAGS_BY_COLLECTION,
  VALID_COLLECTIONS,
  validTiersFor,
  type SpecialSerialTag,
  type OwnersCollection,
  type OwnersSortKey,
} from "@/lib/special-serial-owners-board"

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const sp = new URL(req.url).searchParams

  const collRaw = sp.get("collection")?.trim() || "nba-top-shot"
  if (!VALID_COLLECTIONS.includes(collRaw as OwnersCollection)) {
    return NextResponse.json(
      { error: `collection must be one of ${VALID_COLLECTIONS.join(",")}` },
      { status: 400 }
    )
  }
  const collection = collRaw as OwnersCollection
  const validTags = VALID_TAGS_BY_COLLECTION[collection]
  const validTiers = validTiersFor(collection)

  const tagRaw = sp.get("tag")?.trim() || null
  if (tagRaw && !validTags.includes(tagRaw as SpecialSerialTag)) {
    return NextResponse.json(
      { error: `tag must be one of ${validTags.join(",")}` },
      { status: 400 }
    )
  }
  const tag = (tagRaw as SpecialSerialTag) ?? null

  const tier = sp.get("tier")?.trim().toUpperCase() || null
  if (tier && !validTiers.has(tier)) {
    return NextResponse.json(
      { error: `tier must be one of ${[...validTiers].join(",")}` },
      { status: 400 }
    )
  }

  const player = sp.get("player")?.trim() || null
  const holder = sp.get("holder")?.trim() || null

  const sortRaw = sp.get("sort")?.trim().toLowerCase() || "fmv"
  const sort: OwnersSortKey = sortRaw === "recent" ? "recent" : "fmv"

  const limit = Math.max(1, Math.min(200, Number(sp.get("limit") ?? "100") || 100))
  const offset = Math.max(0, Number(sp.get("offset") ?? "0") || 0)

  let rows
  try {
    // withBoardBudget REJECTS on overrun, which is the right flavour HERE and
    // the wrong one three lines further down: this read already sits inside a
    // try/catch whose catch is `boardUnavailable`, so a rejection lands exactly
    // where a failed read is already handled. (`boundedRead` is the resolving
    // flavour, for the far commoner shape in this tree — a bare destructured
    // read with no catch at all.) The helper reads through a lib/ fetcher, so
    // nothing here can see the individual queries; the bound is on the whole.
    rows = await withBoardBudget(
      fetchSpecialSerialOwners(supabase, { tag, tier, player, holder, sort, limit, offset, collection }),
      "special-serial-owners",
    )
  } catch (e) {
    return boardUnavailable(e, "special-serial-owners")
  }

  // Resolve holder wallet → @username (Item 7, 2026-06-22 audit) so the board
  // reads "@JJLSmith" not a raw 0x…, matching the edition page + recent-sales
  // rows. Service-role read (the page is anon and can't call the auth-gated
  // analytics resolver). Addresses with no username keep the truncated fallback.
  try {
    const addrs = Array.from(
      new Set(rows.map((r) => r.holder_address).filter(Boolean).map((a) => (a as string).toLowerCase())),
    )
    if (addrs.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: nameRows } = await (supabase.from("wallet_usernames") as any)
        .select("wallet_addr, username")
        .in("wallet_addr", addrs)
        .not("username", "is", null)
      const nameByAddr = new Map<string, string>()
      for (const nr of (nameRows ?? []) as Array<{ wallet_addr: string; username: string | null }>) {
        if (nr.wallet_addr && nr.username) nameByAddr.set(nr.wallet_addr.toLowerCase(), nr.username)
      }
      for (const r of rows) {
        r.holder_username = r.holder_address ? nameByAddr.get(r.holder_address.toLowerCase()) ?? null : null
      }
    }
  } catch (e) {
    console.error("[public/special-serial-owners] username resolve", e instanceof Error ? e.message : String(e))
  }

  const elapsedMs = Date.now() - startedAt
  console.log(
    `[public/special-serial-owners] returned=${rows.length} collection=${collection} tag=${tag ?? "*"} tier=${tier ?? "*"} player=${player ?? "*"} holder=${holder ? "set" : "*"} sort=${sort} limit=${limit} offset=${offset} elapsedMs=${elapsedMs}`
  )

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: collection === "nfl-all-day"
        ? "allday_special_serial_owners_mv"
        : "topshot_special_serial_owners_mv",
      total_rows: rows.length,
      elapsed_ms: elapsedMs,
      filters: { collection, tag, tier, player, holder, sort, limit, offset },
    },
    rows,
  })

  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=300")
  return res
}
