// app/api/pin-list/route.ts
//
// GET /api/pin-list?wallet=0x...[&format=json|txt|script]
//
// Per-wallet IPFS pin export. Joins a collector's Top Shot holdings to the
// distinct media CIDs that back them (Dapper pinned the full Top Shot media
// corpus to IPFS, 2026-06-08) so a collector can host their own collection.
//
// Auth: requires a Supabase user session AND that the requested wallet is one
// of the user's saved wallets (any collection — verification not required; the
// data is public-chain-derived and non-sensitive, the saved_wallets check just
// stops a signed-in user from scanning arbitrary wallets and burning the RPC).
//
// Wraps the service-role-only RPC get_wallet_ipfs_pin_list(p_wallet) →
// TABLE(cid, media_type, pin_size, editions_held, moments_held), one row per
// distinct CID. The RPC handles both the Base join and the parallel-name join
// internally — do not re-derive keys in route code.
//
// Formats:
//   json   (default) — { wallet, cid_count, total_bytes, total_human, by_type }
//                       summary only; the ~27k-CID row set is NOT serialized
//                       here so the dashboard card stays light.
//   txt              — newline-separated bare CIDs (download).
//   script           — a commented `ipfs pin add <cid>` bash script (download).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

export const dynamic = "force-dynamic"

interface PinRow {
  cid: string
  media_type: string | null
  pin_size: number | null
  editions_held: number | null
  moments_held: number | null
}

function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  // GB/TB get one decimal; smaller units stay whole.
  return `${i >= 3 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export async function GET(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  const url = req.nextUrl
  const wallet = (url.searchParams.get("wallet") ?? "").toLowerCase().trim()
  const format = (url.searchParams.get("format") ?? "json").trim().toLowerCase()

  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }
  if (format !== "json" && format !== "txt" && format !== "script") {
    return NextResponse.json({ error: "invalid format: " + format }, { status: 400 })
  }

  // Ownership gate: wallet must be saved on this account (any collection).
  const { data: owned, error: lookupErr } = await sb
    .from("saved_wallets")
    .select("wallet_addr")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .limit(1)

  if (lookupErr) {
    console.error("[pin-list] saved_wallets lookup", lookupErr.message)
    return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  }
  if (!owned || owned.length === 0) {
    return NextResponse.json(
      { error: "wallet not saved on this account" },
      { status: 403 },
    )
  }

  let rows: PinRow[]
  try {
    const { data, error } = await sb.rpc("get_wallet_ipfs_pin_list", { p_wallet: wallet })
    if (error) {
      console.error("[pin-list]", error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    rows = (data ?? []) as PinRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[pin-list] unexpected", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  // Aggregate. media_type values are variant labels (VIDEO, VIDEO_TALL, HERO,
  // PLAYER, IMAGE_PLAYER, …) — bucket VIDEO* as video and everything else as
  // artwork for the headline split, while keeping the raw per-variant counts.
  let totalBytes = 0
  const byType: Record<string, { count: number; bytes: number }> = {}
  const split = {
    video: { count: 0, bytes: 0 },
    artwork: { count: 0, bytes: 0 },
  }
  for (const r of rows) {
    const size = Number(r.pin_size) || 0
    totalBytes += size
    const t = r.media_type || "OTHER"
    if (!byType[t]) byType[t] = { count: 0, bytes: 0 }
    byType[t].count += 1
    byType[t].bytes += size
    const bucket = t.toUpperCase().startsWith("VIDEO") ? split.video : split.artwork
    bucket.count += 1
    bucket.bytes += size
  }

  // Collection churn is slow and the catalog refreshes daily — an hour of edge
  // cache is safe. (Signed-in requests carry a cookie so this is effectively a
  // hint; the per-component fetch is the real guard against load.)
  const cacheHeaders = { "Cache-Control": "private, max-age=3600" }

  if (format === "txt") {
    const body = rows.map((r) => r.cid).join("\n") + (rows.length ? "\n" : "")
    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${wallet}-cids.txt"`,
        ...cacheHeaders,
      },
    })
  }

  if (format === "script") {
    const lines: string[] = []
    lines.push("#!/usr/bin/env bash")
    lines.push("#")
    lines.push("# Pin your NBA Top Shot collection to IPFS — hosted by you.")
    lines.push("#")
    lines.push(`# Wallet:     ${wallet}`)
    lines.push(`# CIDs:       ${rows.length.toLocaleString("en-US")}`)
    lines.push(`# Total size: ${humanBytes(totalBytes)}`)
    lines.push("# Generated by Rip Packs City — https://www.rippackscity.com")
    lines.push("#")
    lines.push("# Requires a running IPFS node (Kubo CLI or IPFS Desktop):")
    lines.push("#   https://docs.ipfs.tech/install/")
    lines.push("# Then: chmod +x this file and run it. Each pin is idempotent.")
    lines.push("#")
    lines.push("set -euo pipefail")
    lines.push("")
    for (const r of rows) {
      lines.push(`ipfs pin add ${r.cid}`)
    }
    lines.push("")
    const body = lines.join("\n")
    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/x-shellscript; charset=utf-8",
        "Content-Disposition": `attachment; filename="pin-collection-${wallet}.sh"`,
        ...cacheHeaders,
      },
    })
  }

  // Default: lightweight summary for the dashboard card.
  return NextResponse.json(
    {
      wallet,
      cid_count: rows.length,
      total_bytes: totalBytes,
      total_human: humanBytes(totalBytes),
      split,
      by_type: byType,
    },
    { headers: cacheHeaders },
  )
}
