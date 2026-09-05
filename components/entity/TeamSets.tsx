"use client"

// components/entity/TeamSets.tsx
// Team Hub Phase 3 (C8). Client island. Sets featuring the team (count + cheapest
// entry), from get_team_sets via /api/entity/team-sets. The no-wallet list is
// rendered server-side and passed as `initial`; on mount we read the wallet the
// Team Checklist persisted in localStorage and, if present, refetch with it to
// show "You own X / Y" per set (kept in sync with the checklist).

import { useEffect, useState } from "react"
import Link from "next/link"
import { EM_DASH, fmtCount, fmtUsd } from "./_shared"
import { sectionEmptyCopy } from "@/lib/entity/section-empty-copy"

export interface SetRow {
  set_slug: string
  set_name: string | null
  editions: number | null
  cheapest_entry_usd: number | null
  owned: number | null
}

const LS_KEY = "rpc_checklist_wallet"
const WALLET_RE = /^0x[0-9a-f]{16}$/

export default function TeamSets({
  collectionUrlSlug,
  teamSlug,
  initial,
  // ⚠ `initialOk` is the SEED'S PROVENANCE, and without it this component was
  // structurally unable to be honest. `initial` arrives as `[]` from BOTH "this
  // team has no sets" and "get_team_sets failed" — `sectionRows` degraded a
  // failed RPC to an empty array by policy and dropped `ok` on the floor — so
  // "No sets yet." was published out of a timeout on a public SEO page.
  //
  // ⚠ Defaults TRUE so an omitted prop cannot silently mark a healthy section
  // degraded; the page passes it explicitly.
  initialOk = true,
}: {
  collectionUrlSlug: string
  teamSlug: string
  initial: SetRow[]
  initialOk?: boolean
}) {
  const [rows, setRows] = useState<SetRow[]>(initial)
  // A SUCCESSFUL client refetch proves the read works, so it clears a degraded
  // seed rather than leaving the warning up next to real rows.
  const [ok, setOk] = useState(initialOk)
  const [tracking, setTracking] = useState(false)

  useEffect(() => {
    let wallet: string | null = null
    try {
      const saved = window.localStorage.getItem(LS_KEY)
      if (saved && WALLET_RE.test(saved.toLowerCase())) wallet = saved.toLowerCase()
    } catch { /* localStorage unavailable */ }
    if (!wallet) return
    setTracking(true)
    const p = new URLSearchParams({ collection: collectionUrlSlug, slug: teamSlug, wallet })
    fetch(`/api/entity/team-sets?${p.toString()}`, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then((next: SetRow[] | null) => {
        if (Array.isArray(next)) {
          // The read succeeded — even an empty answer is now a MEASURED empty.
          setOk(true)
          if (next.length) setRows(next)
        }
      })
      .catch(() => { /* keep the no-wallet list */ })
  }, [collectionUrlSlug, teamSlug])

  if (!rows || rows.length === 0) {
    return (
      <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
        {sectionEmptyCopy(ok, "Sets", "No sets yet.")}
      </div>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {rows.map((s) => {
        const ownAll = s.owned != null && s.editions != null && s.owned >= s.editions
        return (
          <Link
            key={s.set_slug}
            href={`/${collectionUrlSlug}/set/${encodeURIComponent(s.set_slug)}`}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,1fr) auto auto",
              gap: 12,
              alignItems: "center",
              padding: "9px 0",
              borderBottom: "1px solid var(--rpc-border-subtle)",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <div style={{ minWidth: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.set_name ?? s.set_slug}
            </div>
            <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              <div className="rpc-mono" style={{ fontSize: 12, color: tracking && s.owned != null ? (ownAll ? "#34D399" : "var(--rpc-text-primary)") : "var(--rpc-text-secondary)" }}>
                {tracking && s.owned != null ? `${fmtCount(s.owned)} / ${fmtCount(s.editions)}` : fmtCount(s.editions)}
              </div>
              <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.10em" }}>
                {tracking && s.owned != null ? "OWNED" : "EDITIONS"}
              </div>
            </div>
            <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.10em" }}>FROM</div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)" }}>
                {s.cheapest_entry_usd != null && s.cheapest_entry_usd > 0 ? fmtUsd(s.cheapest_entry_usd) : EM_DASH}
              </div>
            </div>
          </Link>
        )
      })}
    </div>
  )
}
