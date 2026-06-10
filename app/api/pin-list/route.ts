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
// Wraps the service-role-only RPC get_wallet_ipfs_pin_export(p_wallet) →
// a SINGLE jsonb row so the PostgREST 1000-row cap is structurally irrelevant
// (the older get_wallet_ipfs_pin_list returns one row per CID and gets
// truncated at 1000 through supabase-js — do NOT read it from this route).
// The jsonb shape is:
//   { cid_count, total_bytes, video:{count,bytes}, artwork:{count,bytes},
//     by_type:{<media_type>:count}, cids_text:"<CIDs, newline-separated, pin_size DESC>" }
// The RPC handles both the Base join and the parallel-name join internally —
// do not re-derive keys in route code.
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

interface PinExport {
  cid_count: number | null
  total_bytes: number | null
  video: { count: number; bytes: number } | null
  artwork: { count: number; bytes: number } | null
  by_type: Record<string, number> | null
  cids_text: string | null
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

  let exp: PinExport
  try {
    const { data, error } = await sb.rpc("get_wallet_ipfs_pin_export", { p_wallet: wallet })
    if (error) {
      console.error("[pin-list]", error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    exp = (data ?? {}) as PinExport
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[pin-list] unexpected", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  // The single-row RPC already did the aggregation. video/artwork are the
  // headline VIDEO*-vs-rest split; by_type is per-variant counts; cids_text is
  // the newline-separated CID list ordered pin_size DESC.
  const cidCount = Number(exp.cid_count) || 0
  const totalBytes = Number(exp.total_bytes) || 0
  const split = {
    video: { count: Number(exp.video?.count) || 0, bytes: Number(exp.video?.bytes) || 0 },
    artwork: { count: Number(exp.artwork?.count) || 0, bytes: Number(exp.artwork?.bytes) || 0 },
  }
  const byType = exp.by_type ?? {}
  const cidsText = (exp.cids_text ?? "").trim()
  const cids = cidsText ? cidsText.split("\n") : []

  // Collection churn is slow and the catalog refreshes daily — an hour of edge
  // cache is safe. (Signed-in requests carry a cookie so this is effectively a
  // hint; the per-component fetch is the real guard against load.)
  const cacheHeaders = { "Cache-Control": "private, max-age=3600" }

  if (format === "txt") {
    const body = cids.join("\n") + (cids.length ? "\n" : "")
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
    lines.push(`# CIDs:       ${cids.length.toLocaleString("en-US")}`)
    lines.push(`# Total size: ${humanBytes(totalBytes)}`)
    lines.push("# Generated by Rip Packs City — https://www.rippackscity.com")
    lines.push("#")
    lines.push("# Requires a running IPFS node (Kubo CLI or IPFS Desktop):")
    lines.push("#   https://docs.ipfs.tech/install/")
    lines.push("# Then: chmod +x this file and run it. Each pin is idempotent.")
    lines.push("#")
    lines.push("set -euo pipefail")
    lines.push("")
    for (const cid of cids) {
      lines.push(`ipfs pin add ${cid}`)
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
      cid_count: cidCount,
      total_bytes: totalBytes,
      total_human: humanBytes(totalBytes),
      split,
      by_type: byType,
    },
    { headers: cacheHeaders },
  )
}
