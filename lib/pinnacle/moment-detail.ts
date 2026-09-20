// lib/pinnacle/moment-detail.ts
//
// The read behind /pinnacle/moment/[id] — the platform's shareable PINNACLE pin
// URL, and the sister surface to /moment/[id].
//
// ⚠ WHY THIS IS IN lib/. It lived in a `page.tsx`, which neither coverage gate
// measures, and it is the densest such page on the repo: thirteen query sites,
// six of them fired in one `Promise.all`. Every honesty property below —
// which failures 404, which degrade, which must NOT be published as a number —
// was pinned only by source greps that prove a string is present, never that
// the branch resolves the way the comment claims.
//
// ⚠ THE DEFECT THAT MOTIVATED THE MOVE: `holders` was
// `Number(holdersRes.count ?? 0)`. supabase-js RETURNS errors rather than
// throwing, so a failed count — a 57014 statement timeout is the realistic case
// on this instance — leaves `count` null, and the `??` published a hard **0**
// under "Tracked holders / in RPC wallet cache". That is a claim about OUR OWN
// data manufactured from OUR OWN outage, on a public page a collector shares.
// It now carries null, which the page already renders as an em-dash. Same
// `?? 0`-on-a-supabase-count shape as /api/rewards/summary.

import { supabaseAdmin } from "@/lib/supabase"
import {
  pinnacleSerialLadder,
  toMultiplierMap,
  type PinnacleMultiplierRow,
} from "@/lib/pinnacle/serial-fmv"
import type { PinnacleFmvPoint } from "@/components/pinnacle/PinnacleFmvChart"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

/**
 * Wall-clock budget for the WHOLE of `load()`, shared across every read in it.
 *
 * ⚠ Shared, not per-read, because `load()` is a CHAIN: catalog read → (numeric
 * resolve, up to two more reads) → catalog re-read → a six-way `Promise.all` →
 * a usernames read. Six per-read budgets would let a saturated DB spend the
 * budget six times over, and the bound would multiply the worst case it exists
 * to cap.
 *
 * ⚠ And a read that is merely SLOW errors nowhere — supabase-js resolves
 * `{ data, error }` only when the query finishes — so without this the page
 * hangs on a streaming shell that Vercel logs as a 200.
 */
const PIN_LOAD_TIMEOUT_MS = 8_000

/**
 * A PostgREST row as this module has always handled it — loosely, because the
 * shape guarantee lives in the `RenderData` / `LegacyData` types the function
 * returns rather than at each query. Declared once so the bounded reads below do
 * not each need their own escape hatch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

/** The `{ data, error }` envelope every bounded read here resolves with. */
type Envelope = { data: Row; error: { message: string } | null }

/** Bound one read against a deadline shared by the whole `load()` call. */
function bounded<T>(p: PromiseLike<T>, label: string, deadline: number): Promise<T> {
  return withBoardBudget(
    Promise.resolve(p),
    label,
    Math.max(1, deadline - Date.now()),
    "pinnacle/moment/",
  )
}


export const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

// render_id never contains ':'; the legacy set-level key (royalty:variant:printing)
// always does. That's the discriminator between the two URL shapes.
export function isLegacyKey(id: string): boolean {
  return id.includes(":")
}

export function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export type CatalogRow = {
  render_id: string
  edition_id: string | null
  character_name: string | null
  set_name: string | null
  franchises: string[] | null
  variant: string | null
  parallel_type: string | null
  printing: number | null
  total_minted: number | null
  edition_type: string | null
  limited_edition: boolean | null
  series_name: string | null
  is_chaser: boolean | null
  color: string | null
  effects: string | null
  materials: string | null
  size: string | null
  thickness: string | null
  thumbnail_url: string | null
  fmv_usd: number | null
  fmv_wap_usd: number | null
  fmv_confidence: string | null
  fmv_sales_count_30d: number | null
  fmv_days_since_sale: number | null
  fmv_computed_at: string | null
  floor_ask: number | null
}

export type SaleRow = {
  sale_price_usd: number | null
  sold_at: string | null
  serial_number: number | null
  buyer_address: string | null
  seller_address: string | null
}

// A sibling printing of the SAME pin (same shape_render_id) — a different variant
// (Standard / Golden / Digital Display / …) or printing. Each is its own render
// with its own circulation + per-render FMV, and links to its own render page.
export type SiblingRow = {
  render_id: string
  character_name: string | null
  set_name: string | null
  variant: string | null
  printing: number | null
  total_minted: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
  fmv_confidence: string | null
  floor_ask: number | null
  is_self: boolean
}

export type RenderData = {
  kind: "render"
  ed: CatalogRow
  sales: SaleRow[]
  /**
   * ⚠ null when the COUNT FAILED, never 0. A supabase-js count returns `null`
   * on error just as it would if you asked and got nothing, so `?? 0` — which
   * is what this was — publishes "Tracked holders 0" out of a statement
   * timeout. A genuinely-zero count is still 0 and must keep rendering as 0;
   * the page prints null as an em-dash.
   */
  holders: number | null
  variant_avg_mint: number | null
  scarcity_pct: number | null
  siblings: SiblingRow[]
  fmvHistory: PinnacleFmvPoint[]
  nameByAddr: Record<string, string>
  // P4: serial-premium value ladder — what different serial tiers of THIS render
  // are worth, from the render-keyed Pinnacle serial-FMV model (overlay on the
  // flat render FMV). Null for un-numbered / unpriced renders.
  serialLadder: { label: string; note: string; estimate: number; mult: number }[] | null
}

export type LegacyRender = {
  render_id: string
  character_name: string | null
  set_name: string | null
  variant: string | null
  total_minted: number | null
  fmv_usd: number | null
  thumbnail_url: string | null
}

export type LegacyData = { kind: "legacy"; key: string; renders: LegacyRender[] }

export const CATALOG_COLS =
  "render_id, edition_id, character_name, set_name, franchises, variant, parallel_type, printing, total_minted, edition_type, limited_edition, series_name, is_chaser, color, effects, materials, size, thickness, thumbnail_url, fmv_usd, fmv_wap_usd, fmv_confidence, fmv_sales_count_30d, fmv_days_since_sale, fmv_computed_at, floor_ask"

// A render_id (OEV1-WINN-GOPH-S3) is the canonical key, but the page is also
// reached with two other legitimate numeric id shapes that must resolve, not
// 404: the catalog edition_id (3-digit, e.g. 2156 — links from older catalog
// references) and the on-chain moment NFT id (~15-digit, e.g. 111050675472028 —
// links from a held pin / wallet surface). Both map 1:1 to a render_id, so we
// redirect them onto the canonical render before loading. wmc has 100% render_id
// coverage for Pinnacle, so any held pin resolves.
/** Sentinel distinguishing "this numeric id maps to no render" (null — a real
 *  answer) from "we could not ask" (this — must not become a 404). A sentinel
 *  rather than a third `ok` field keeps the two call sites' branching readable. */
const RESOLVE_FAILED = Symbol("resolve_failed")

async function resolveNumericToRenderId(
  supa: any,
  id: string,
  // ⚠ Takes the CALLER's deadline rather than starting its own. This helper runs
  // two more reads inside a chain that has already spent budget; giving it a
  // fresh allowance is how a "bound" quietly becomes three.
  deadline: number,
): Promise<string | null | typeof RESOLVE_FAILED> {
  if (!/^\d+$/.test(id)) return null
  // edition_id is the smaller (3-digit) space; check it first.
  let byEdition: Row
  try {
    const r = await bounded<Envelope>(
      supa.from("pinnacle_catalog").select("render_id").eq("edition_id", id).maybeSingle(),
      "resolve-by-edition",
      deadline,
    )
    if (r.error) {
      console.log("[pinnacle/moment] resolve_by_edition_error", r.error.message)
      return RESOLVE_FAILED
    }
    byEdition = r.data
  } catch (e) {
    // ⚠ RESOLVE_FAILED, not null. `null` here means "asked, and no such pin",
    // which the caller is entitled to render as a 404 — see PinLoad. A read we
    // could not finish must not become that answer.
    console.log("[pinnacle/moment] resolve_by_edition_bound", e instanceof Error ? e.message : e)
    return RESOLVE_FAILED
  }
  if (byEdition?.render_id) return byEdition.render_id as string
  // Otherwise treat it as an on-chain moment NFT id.
  try {
    const r = await bounded<Envelope>(
      supa
        .from("wallet_moments_cache")
        .select("render_id")
        .eq("collection_id", PINNACLE_COLLECTION_ID)
        .eq("moment_id", id)
        .not("render_id", "is", null)
        .limit(1)
        .maybeSingle(),
      "resolve-by-moment",
      deadline,
    )
    if (r.error) {
      console.log("[pinnacle/moment] resolve_by_moment_error", r.error.message)
      return RESOLVE_FAILED
    }
    return (r.data?.render_id as string) ?? null
  } catch (e) {
    console.log("[pinnacle/moment] resolve_by_moment_bound", e instanceof Error ? e.message : e)
    return RESOLVE_FAILED
  }
}

/**
 * Outcome of the pin read.
 *
 * ⚠ `ok` answers "did the READ succeed", NOT "is there such a pin". Before this
 * existed, NONE of the reads in `load` destructured `error` at all — supabase-js
 * RETURNS errors rather than throwing, so a statement timeout left `data`
 * undefined, fell through `renders.length === 0` / `if (!ed)`, and returned a
 * bare `null` that the caller answered with `notFound()`. This is the platform's
 * shareable Pinnacle pin URL: that told a collector who had just posted the link
 * that their pin does not exist, and handed a crawler a hard 404 for a real page.
 * Same class fixed on /moment/[id]; the Pinnacle sibling was never swept.
 */
export type PinLoad = { data: RenderData | LegacyData | null; ok: boolean }

export async function load(
  rawId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<PinLoad> {
  const supa = db
  const id = decodeId(rawId)
  const deadline = Date.now() + PIN_LOAD_TIMEOUT_MS

  if (isLegacyKey(id)) {
    let data: unknown
    let error: { message: string } | null = null
    try {
      ;({ data, error } = await bounded<{ data: unknown; error: { message: string } | null }>(
        supa
          .from("pinnacle_catalog")
          .select(
            "render_id, character_name, set_name, variant, total_minted, fmv_usd, thumbnail_url",
          )
          .eq("legacy_edition_key", id)
          .order("fmv_usd", { ascending: false, nullsFirst: false }),
        "legacy-read",
        deadline,
      ))
    } catch (e) {
      console.log("[pinnacle/moment] legacy_read_bound", e instanceof Error ? e.message : e)
      return { data: null, ok: false }
    }
    if (error) {
      console.log("[pinnacle/moment] legacy_read_error", error.message)
      return { data: null, ok: false }
    }
    const renders = (data ?? []) as LegacyRender[]
    if (renders.length === 0) return { data: null, ok: true }
    return { data: { kind: "legacy", key: id, renders }, ok: true }
  }

  let ed: Row
  let edError: { message: string } | null = null
  try {
    ;({ data: ed, error: edError } = await bounded<Envelope>(
      supa.from("pinnacle_catalog").select(CATALOG_COLS).eq("render_id", id).maybeSingle(),
      "catalog-read",
      deadline,
    ))
  } catch (e) {
    console.log("[pinnacle/moment] catalog_read_bound", e instanceof Error ? e.message : e)
    return { data: null, ok: false }
  }
  if (edError) {
    console.log("[pinnacle/moment] catalog_read_error", edError.message)
    return { data: null, ok: false }
  }
  // Numeric id (edition_id or moment NFT id) → redirect onto its render_id.
  if (!ed) {
    const resolved = await resolveNumericToRenderId(supa, id, deadline)
    // A FAILED resolve is not an absent pin — see PinLoad.
    if (resolved === RESOLVE_FAILED) return { data: null, ok: false }
    if (resolved) {
      try {
        ;({ data: ed, error: edError } = await bounded<Envelope>(
          supa.from("pinnacle_catalog").select(CATALOG_COLS).eq("render_id", resolved).maybeSingle(),
          "catalog-reread",
          deadline,
        ))
      } catch (e) {
        console.log("[pinnacle/moment] catalog_reread_bound", e instanceof Error ? e.message : e)
        return { data: null, ok: false }
      }
      if (edError) {
        console.log("[pinnacle/moment] catalog_reread_error", edError.message)
        return { data: null, ok: false }
      }
    }
  }
  if (!ed) return { data: null, ok: true }
  // Canonical render_id — may differ from the incoming id when it arrived as a
  // numeric edition_id / moment NFT id and was redirected above.
  const renderId = ed.render_id as string

  // Sales history (per render) + tracked holders + variant scarcity. The
  // scarcity board already computes the per-variant average, so reuse it
  // rather than re-aggregating the catalog (and tripping the 1000-row cap on
  // big variant families).
  // ⚠ Bounded AS A GROUP, on the same shared deadline. Six separate budgets here
  // would each be measured from the moment this line runs, which is already
  // several reads deep — the chain above must count against them.
  let salesRes: Row, holdersRes: Row, boardRes: Row, siblingsRes: Row
  let fmvHistRes: Row, serialMultRes: Row
  try {
    ;[salesRes, holdersRes, boardRes, siblingsRes, fmvHistRes, serialMultRes] = await bounded<Row[]>(
      Promise.all([
    supa
      .from("pinnacle_sales")
      .select("sale_price_usd, sold_at, serial_number, buyer_address, seller_address")
      .eq("render_id", renderId)
      .order("sold_at", { ascending: false, nullsFirst: false })
      .limit(25),
    supa
      .from("wallet_moments_cache")
      .select("moment_id", { count: "exact", head: true })
      .eq("collection_id", PINNACLE_COLLECTION_ID)
      .eq("render_id", renderId),
    supa
      .from("pinnacle_scarcity_board")
      .select("variant_avg_mint, scarcity_vs_variant_pct")
      .eq("render_id", renderId)
      .maybeSingle(),
    // Other printings of THIS pin (same shape_render_id) — the parallel ladder.
    supa.rpc("get_pinnacle_variant_siblings", { p_render_id: renderId }),
    // Per-render FMV history (engine pinnacle-2.0.0-render) — powers the chart.
    supa
      .from("pinnacle_fmv_history")
      .select("computed_at, fmv_usd, fmv_confidence, fmv_sales_count_30d")
      .eq("render_id", renderId)
      .order("computed_at", { ascending: true })
      .limit(400),
    // P4: global Pinnacle serial-premium bands (first/low5/low20/normal → multiplier).
      supa.from("pinnacle_serial_fmv_multipliers").select("band, multiplier, is_reliable"),
      ]),
      "detail-bundle",
      deadline,
    )
  } catch (e) {
    // ⚠ `ok: false`, NOT a 404. Every panel below is derived from this group, and
    // returning `{ data: null, ok: true }` would tell a visitor the pin does not
    // exist because our database was busy.
    console.log("[pinnacle/moment] detail_bundle_bound", e instanceof Error ? e.message : e)
    return { data: null, ok: false }
  }

  const siblings = Array.isArray(siblingsRes.data) ? (siblingsRes.data as SiblingRow[]) : []
  const sales = (salesRes.data ?? []) as SaleRow[]

  // Resolve buyer/seller usernames (best-effort) so Recent Sales matches the
  // TS/AllDay convention (@name vs truncated 0x…).
  const addrs = Array.from(
    new Set(
      sales
        .flatMap((s) => [s.buyer_address, s.seller_address])
        .filter((a): a is string => !!a)
        .map((a) => a.toLowerCase()),
    ),
  )
  const nameByAddr: Record<string, string> = {}
  if (addrs.length > 0) {
    // degrades-on-error: intentional — this is DECORATION. A failed username
    // lookup leaves nameByAddr empty and the buyer/seller columns render raw
    // addresses, which understates (the safe direction) rather than asserting
    // anything false. It must not participate in the ok/notFound decision.
    try {
      const { data: unames } = await bounded<{ data: unknown }>(
        supa.from("wallet_usernames").select("wallet_addr, username").in("wallet_addr", addrs),
        "usernames",
        deadline,
      )
      for (const u of (unames as { wallet_addr: string; username: string | null }[] | null) ?? []) {
        if (u.username) nameByAddr[u.wallet_addr.toLowerCase()] = u.username
      }
    } catch (e) {
      // ⚠ Swallowed on purpose, matching the note above: this is DECORATION, and
      // its failure leaves raw addresses, which understates rather than asserting
      // anything false. It must NOT flip ok/notFound. Logged rather than silent,
      // because a bound nobody can see is indistinguishable from one that never
      // fires.
      console.log("[pinnacle/moment] usernames_bound", e instanceof Error ? e.message : e)
    }
  }

  // P4: the serial-premium value ladder for numbered renders. The band math,
  // the multiplier map and the mint>=25 display guard all live in
  // lib/pinnacle/serial-fmv.ts — the ONE implementation, shared with the wallet
  // view and cross-checked against the SQL pinnacle_serial_fmv_estimate.
  const mult = toMultiplierMap(serialMultRes.data as PinnacleMultiplierRow[] | null)
  const serialLadder = pinnacleSerialLadder(
    ed.total_minted != null ? Number(ed.total_minted) : null,
    ed.fmv_usd != null ? Number(ed.fmv_usd) : null,
    mult,
  )

  return {
    data: {
      kind: "render",
      ed: ed as CatalogRow,
      sales,
      // ⚠ Branch on the ERROR, not on the value: a successful count of zero and
      // a failed count are both `null` in `count`, and only one of them is an
      // answer. The other five reads in the Promise.all degrade to an omitted
      // section or an em-dash, which understates — the safe direction — so this
      // is the one that needed a flag.
      holders: holdersRes.error ? null : Number(holdersRes.count ?? 0),
      variant_avg_mint: boardRes.data?.variant_avg_mint != null ? Number(boardRes.data.variant_avg_mint) : null,
      scarcity_pct: boardRes.data?.scarcity_vs_variant_pct != null ? Number(boardRes.data.scarcity_vs_variant_pct) : null,
      siblings,
      fmvHistory: ((fmvHistRes.data ?? []) as PinnacleFmvPoint[]),
      nameByAddr,
      serialLadder,
    },
    ok: true,
  }
}
