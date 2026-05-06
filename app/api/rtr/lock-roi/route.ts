// app/api/rtr/lock-roi/route.ts
//
// Authenticated. Returns up to ROW_CAP moments owned by the requested
// wallet, sorted by points-per-dollar descending. Source path:
//   wallet_moments_cache  → editions(external_id, collection_id)
//                         → fmv_snapshots (latest per edition)
//
// "currentFmvUsd" prefers the freshest fmv_snapshots row (joined via
// edition.id) and falls back to wallet_moments_cache.fmv_usd if no
// snapshot is found. Rows without any usable FMV (null or ≤ 0) are
// dropped — pointsPerDollar would be undefined/Infinity for those.
//
// Per-wallet result is cached in-process for 5 minutes so a noisy UI
// (mobile re-render storms, fast tab switches) doesn't hammer Supabase.

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

const ROUTE_HEADERS: Record<string, string> = { "X-RPC-Route": "rtr-lock-roi" }
const NBA_TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ROW_CAP = 200
const CHUNK = 50
const CACHE_TTL_MS = 5 * 60 * 1000

interface LockRoiRow {
  momentId: string
  playerName: string | null
  setName: string | null
  currentFmvUsd: number
  isLocked: boolean
  estimatedPlayoffPoints: number
  pointsPerDollar: number
  serialNumber: number | null
  tier: string | null
}

interface LockRoiPayload {
  walletAddr: string
  rowCount: number
  totalAvailable: number
  moments: LockRoiRow[]
}

interface CacheEntry {
  expiresAt: number
  payload: LockRoiPayload
}

// Module-scoped cache survives across requests on the same lambda
// instance. Cold starts wipe it; that's fine for a 5-minute TTL.
const cache: Map<string, CacheEntry> = new Map()

const bodySchema = z.object({
  walletAddr: z.string().regex(/^0x[a-f0-9]{16}$/i, "walletAddr must be a 0x + 16 hex Flow address"),
})

export async function POST(req: NextRequest) {
  // Auth — RTR Lock ROI is gated to logged-in users since it's a
  // pro-grade analysis. Unauthed requests bounce with the standard 401
  // shape from requireUser.
  try {
    await requireUser()
  } catch (res) {
    return res as Response
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "malformed_json" }, { status: 400, headers: ROUTE_HEADERS })
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.format() },
      { status: 400, headers: ROUTE_HEADERS },
    )
  }
  const walletAddr = parsed.data.walletAddr.toLowerCase()

  const now = Date.now()
  const cached = cache.get(walletAddr)
  if (cached && cached.expiresAt > now) {
    return NextResponse.json(cached.payload, { headers: { ...ROUTE_HEADERS, "X-RPC-Cache": "hit" } })
  }

  try {
    const { data: cacheRows, error: cacheErr } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id, edition_key, player_name, set_name, tier, is_locked, fmv_usd, serial_number")
      .eq("wallet_address", walletAddr)
      .eq("collection_id", NBA_TOP_SHOT_UUID)
    if (cacheErr) {
      console.error("[rtr-lock-roi] wallet_moments_cache:", cacheErr.message)
      return NextResponse.json(
        { error: "internal_error", detail: cacheErr.message },
        { status: 500, headers: ROUTE_HEADERS },
      )
    }
    const rows = cacheRows ?? []
    if (rows.length === 0) {
      const empty: LockRoiPayload = { walletAddr, rowCount: 0, totalAvailable: 0, moments: [] }
      cache.set(walletAddr, { expiresAt: now + CACHE_TTL_MS, payload: empty })
      return NextResponse.json(empty, { headers: ROUTE_HEADERS })
    }

    const editionKeys = Array.from(new Set(rows.map(r => r.edition_key).filter(Boolean))) as string[]

    const editionByExt = new Map<string, string>()
    for (let i = 0; i < editionKeys.length; i += CHUNK) {
      const slice = editionKeys.slice(i, i + CHUNK)
      const { data: editionRows } = await supabase
        .from("editions")
        .select("id, external_id")
        .in("external_id", slice)
        .eq("collection_id", NBA_TOP_SHOT_UUID)
      for (const e of editionRows ?? []) {
        if (e.external_id && e.id) editionByExt.set(String(e.external_id), String(e.id))
      }
    }

    const editionUuids = Array.from(new Set(Array.from(editionByExt.values())))
    const fmvByUuid = new Map<string, number>()
    for (let i = 0; i < editionUuids.length; i += CHUNK) {
      const slice = editionUuids.slice(i, i + CHUNK)
      const { data: fmvRows } = await supabase
        .from("fmv_snapshots")
        .select("edition_id, fmv_usd, computed_at")
        .in("edition_id", slice)
        .order("computed_at", { ascending: false })
      // First row for each edition wins (latest computed_at first thanks
      // to the ORDER BY — the .in() returns rows in arbitrary order so
      // the dedupe relies on the per-edition order we just imposed).
      for (const s of fmvRows ?? []) {
        const eid = String(s.edition_id)
        if (!fmvByUuid.has(eid) && s.fmv_usd != null) {
          const n = Number(s.fmv_usd)
          if (Number.isFinite(n) && n > 0) fmvByUuid.set(eid, n)
        }
      }
    }

    const moments: LockRoiRow[] = []
    for (const r of rows) {
      const editionUuid = r.edition_key ? editionByExt.get(String(r.edition_key)) : null
      const fmvFresh = editionUuid ? fmvByUuid.get(editionUuid) : null
      const fmvFallback = r.fmv_usd != null ? Number(r.fmv_usd) : null
      const fmv = (fmvFresh && fmvFresh > 0) ? fmvFresh : (fmvFallback && fmvFallback > 0 ? fmvFallback : null)
      if (fmv == null || fmv <= 0) continue

      // TODO(lock-roi-calibration): estimatedPlayoffPoints = floor(fmv / 10)
      // is the v1 placeholder. Calibrate against actual Top Shot Run 2
      // scoring data once it's collected — the real curve almost certainly
      // bends with tier and serial scarcity, not just FMV.
      const estimatedPlayoffPoints = Math.floor(fmv / 10)
      const pointsPerDollar = estimatedPlayoffPoints / fmv
      moments.push({
        momentId: String(r.moment_id),
        playerName: r.player_name ?? null,
        setName: r.set_name ?? null,
        currentFmvUsd: fmv,
        isLocked: !!r.is_locked,
        estimatedPlayoffPoints,
        pointsPerDollar,
        serialNumber: r.serial_number != null ? Number(r.serial_number) : null,
        tier: r.tier ?? null,
      })
    }

    moments.sort((a, b) => b.pointsPerDollar - a.pointsPerDollar)
    const top = moments.slice(0, ROW_CAP)

    const payload: LockRoiPayload = {
      walletAddr,
      rowCount: top.length,
      totalAvailable: moments.length,
      moments: top,
    }

    cache.set(walletAddr, { expiresAt: now + CACHE_TTL_MS, payload })
    return NextResponse.json(payload, { headers: ROUTE_HEADERS })
  } catch (err: any) {
    console.error("[rtr-lock-roi]", err?.message ?? err)
    return NextResponse.json(
      { error: "internal_error", detail: err?.message ?? String(err) },
      { status: 500, headers: ROUTE_HEADERS },
    )
  }
}
